import React, { useRef, useEffect, useLayoutEffect, useState, CSSProperties } from "react"
// FIX: Changed framer import to directly import addPropertyControls and ControlType.
import { addPropertyControls, ControlType } from "framer"
import * as THREE from "three"
import html2canvas from "html2canvas"

// A simple debounce hook to delay expensive operations like texture capture.
function useDebounce<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState<T>(value);
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);
        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);
    return debouncedValue;
}

// Shaders from the original component, unchanged.
const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const physicsFragmentShader = `
  uniform sampler2D uPreviousFrame; // r: clear, g: water, b: drip
  uniform vec2 uResolution;
  uniform vec2 uMouse;
  uniform float uBrushSize;
  uniform float uRefrostRate;
  uniform float uIsMouseActive;

  varying vec2 vUv;

  void main() {
    vec4 state = texture2D(uPreviousFrame, vUv);
    float clear = state.r;
    float water = state.g;
    float drip = state.b;

    float brush = 0.0;
    if (uIsMouseActive > 0.5) {
      float dist = distance(gl_FragCoord.xy, uMouse);
      brush = 1.0 - smoothstep(0.0, uBrushSize, dist);
    }
    
    float newClear = max(clear, brush);
    float frostRemoved = max(0.0, (newClear - clear) * 0.5);
    water += frostRemoved;
    clear = newClear;

    drip += water * 0.01;

    vec2 dripOffset = vec2(0.0, 1.0 / uResolution.y) * 2.0;
    float incomingDrip = texture2D(uPreviousFrame, vUv - dripOffset).b;
    drip = incomingDrip * 0.985;

    clear = max(clear, drip * 0.9);
    water *= 0.97;
    clear -= uRefrostRate * (1.0 - water);

    clear = clamp(clear, 0.0, 1.0);
    water = clamp(water, 0.0, 1.0);
    drip = clamp(drip, 0.0, 1.0);

    gl_FragColor = vec4(clear, water, drip, 1.0);
  }
`

const copyFragmentShader = `
  uniform sampler2D uTexture;
  uniform vec2 uResolution;
  uniform vec2 uImageResolution;
  varying vec2 vUv;

  vec2 getCoverUv(vec2 uv) {
      vec2 st = uv;
      if (uImageResolution.y > 0.0) {
          float canvasAspect = uResolution.x / uResolution.y;
          float imageAspect = uImageResolution.x / uImageResolution.y;

          if (canvasAspect > imageAspect) {
              float scale = imageAspect / canvasAspect;
              st.y = st.y * scale + (1.0 - scale) / 2.0;
          } else {
              float scale = canvasAspect / imageAspect;
              st.x = st.x * scale + (1.0 - scale) / 2.0;
          }
      }
      return st;
  }

  void main() {
    vec2 imageUv = getCoverUv(vUv);
    gl_FragColor = texture2D(uTexture, imageUv);
  }
`

const blurFragmentShader = `
  uniform sampler2D uInput;
  uniform vec2 uResolution;
  uniform vec2 uDirection;
  varying vec2 vUv;

  void main() {
    vec3 color = vec3(0.0);
    vec2 pixelSize = 1.0 / uResolution.xy;
    float weights[3] = float[](0.2270270270, 0.3162162162, 0.0702702703);
    float offsets[3] = float[](0.0, 1.3846153846, 3.2307692308);

    color += texture2D(uInput, vUv).rgb * weights[0];

    for (int i = 1; i < 3; i++) {
        vec2 offset = offsets[i] * uDirection * pixelSize;
        color += texture2D(uInput, vUv + offset).rgb * weights[i];
        color += texture2D(uInput, vUv - offset).rgb * weights[i];
    }
    
    gl_FragColor = vec4(color, 1.0);
  }
`

const fragmentShader = `
  uniform vec2 uResolution;
  uniform sampler2D uSceneTexture;
  uniform sampler2D uPhysicsState;
  uniform sampler2D uBlurredMap;
  varying vec2 vUv;

  void main() {
    vec4 physics = texture2D(uPhysicsState, vUv);
    float clearFactor = physics.r;
    float waterFactor = physics.g;
    float dripFactor = physics.b;

    float disturbance = (waterFactor * 0.2 + dripFactor) * 0.5;
    vec2 distortion = vec2(dFdx(disturbance), dFdy(disturbance)) * -10.0;
    float revealFactor = smoothstep(0.0, 0.4, clearFactor);

    vec3 sceneColor = texture2D(uSceneTexture, vUv + distortion).rgb;
    vec3 blurredColor = texture2D(uBlurredMap, vUv + distortion).rgb;
    vec3 finalColor = mix(blurredColor, sceneColor, revealFactor);

    finalColor += pow(waterFactor, 2.0) * 0.15 + pow(dripFactor, 2.0) * 0.1;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`
const DOWNSAMPLE_FACTOR = 2;

// Type definition for robust state management
type ThreeState = {
    renderer: THREE.WebGLRenderer;
    camera: THREE.OrthographicCamera;
    geometry: THREE.PlaneGeometry;
    scene: THREE.Scene;
    material: THREE.ShaderMaterial;
    copyScene: THREE.Scene;
    copyMaterial: THREE.ShaderMaterial;
    physicsScene: THREE.Scene;
    physicsMaterial: THREE.ShaderMaterial;
    blurScene: THREE.Scene;
    blurMaterial: THREE.ShaderMaterial;
    physicsRenderTargetA: THREE.WebGLRenderTarget;
    physicsRenderTargetB: THREE.WebGLRenderTarget;
    sceneRenderTarget: THREE.WebGLRenderTarget;
    blurRenderTargetDownsampledA: THREE.WebGLRenderTarget;
    blurRenderTargetDownsampledB: THREE.WebGLRenderTarget;
    mouseVector: THREE.Vector2;
    animationFrameId: number;
};

export default function Goo(props) {
    const {
        imageUrl,
        refrostRate,
        useContentAsTexture,
        children,
        width,
        height,
    } = props
    
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const contentCaptureRef = useRef<HTMLDivElement>(null);
    const mousePosition = useRef({ x: -1000, y: -1000 });
    const isMouseActive = useRef(false);
    const threeState = useRef<Partial<ThreeState>>({});

    const debouncedWidth = useDebounce(width, 300);
    const debouncedHeight = useDebounce(height, 300);

    // Effect for handling mouse and touch interaction correctly.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const updateMousePosition = (clientX, clientY) => {
            if (!canvasRef.current) return;
            const rect = canvasRef.current.getBoundingClientRect();
            if (!isMouseActive.current) isMouseActive.current = true;
            // Calculate mouse position relative to the canvas and flip the Y-axis
            mousePosition.current = {
                x: clientX - rect.left,
                y: rect.height - (clientY - rect.top),
            };
        };

        const handleMouseMove = (event: MouseEvent) => updateMousePosition(event.clientX, event.clientY);
        const handleMouseLeave = () => { isMouseActive.current = false; };
        const handleTouchMove = (event: TouchEvent) => {
            if (event.touches.length > 0) updateMousePosition(event.touches[0].clientX, event.touches[0].clientY);
        };
        const handleTouchEnd = () => { isMouseActive.current = false; };

        canvas.addEventListener("mousemove", handleMouseMove);
        canvas.addEventListener("mouseleave", handleMouseLeave);
        canvas.addEventListener("touchmove", handleTouchMove, { passive: true });
        canvas.addEventListener("touchend", handleTouchEnd);
        canvas.addEventListener("touchcancel", handleTouchEnd);

        return () => {
            canvas.removeEventListener("mousemove", handleMouseMove);
            canvas.removeEventListener("mouseleave", handleMouseLeave);
            canvas.removeEventListener("touchmove", handleTouchMove);
            canvas.removeEventListener("touchend", handleTouchEnd);
            canvas.removeEventListener("touchcancel", handleTouchEnd);
        };
    }, []);

    // Effect for updating the refrost rate from props.
    useEffect(() => {
        if (threeState.current.physicsMaterial) {
            threeState.current.physicsMaterial.uniforms.uRefrostRate.value = refrostRate;
        }
    }, [refrostRate]);

    // Effect for setting up the main THREE.js scene and render loop. Runs only once.
    useEffect(() => {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const state = threeState.current;

        state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        
        state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        state.geometry = new THREE.PlaneGeometry(2, 2);

        state.material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uResolution: { value: new THREE.Vector2() }, uSceneTexture: { value: null }, uPhysicsState: { value: null }, uBlurredMap: { value: null } } });
        state.scene = new THREE.Scene();
        state.scene.add(new THREE.Mesh(state.geometry, state.material));

        state.copyMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: copyFragmentShader, uniforms: { uTexture: { value: null }, uResolution: { value: new THREE.Vector2() }, uImageResolution: { value: new THREE.Vector2() } } });
        state.copyScene = new THREE.Scene();
        state.copyScene.add(new THREE.Mesh(state.geometry, state.copyMaterial));
        
        state.physicsMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: physicsFragmentShader, uniforms: { uPreviousFrame: { value: null }, uResolution: { value: new THREE.Vector2() }, uMouse: { value: new THREE.Vector2() }, uBrushSize: { value: 120.0 }, uRefrostRate: { value: refrostRate }, uIsMouseActive: { value: 0.0 } } });
        state.physicsScene = new THREE.Scene();
        state.physicsScene.add(new THREE.Mesh(state.geometry, state.physicsMaterial));

        state.blurMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: blurFragmentShader, uniforms: { uInput: { value: null }, uResolution: { value: new THREE.Vector2() }, uDirection: { value: new THREE.Vector2() } } });
        state.blurScene = new THREE.Scene();
        state.blurScene.add(new THREE.Mesh(state.geometry, state.blurMaterial));

        const rtOptions = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType, stencilBuffer: false };
        state.physicsRenderTargetA = new THREE.WebGLRenderTarget(1, 1, rtOptions);
        state.physicsRenderTargetB = new THREE.WebGLRenderTarget(1, 1, rtOptions);
        state.sceneRenderTarget = new THREE.WebGLRenderTarget(1, 1, rtOptions);
        state.blurRenderTargetDownsampledA = new THREE.WebGLRenderTarget(1, 1, rtOptions);
        state.blurRenderTargetDownsampledB = new THREE.WebGLRenderTarget(1, 1, rtOptions);
        
        state.mouseVector = new THREE.Vector2(-1000, -1000);

        const animate = () => {
            state.animationFrameId = requestAnimationFrame(animate);
            if (!state.renderer || !state.physicsMaterial || !state.copyMaterial || !state.blurMaterial || !state.material) return;

            state.mouseVector.lerp(mousePosition.current, 0.1);

            state.renderer.setRenderTarget(state.physicsRenderTargetB);
            state.physicsMaterial.uniforms.uPreviousFrame.value = state.physicsRenderTargetA.texture;
            state.physicsMaterial.uniforms.uMouse.value.copy(state.mouseVector);
            state.physicsMaterial.uniforms.uIsMouseActive.value = isMouseActive.current ? 1.0 : 0.0;
            state.renderer.render(state.physicsScene, state.camera);
            [state.physicsRenderTargetA, state.physicsRenderTargetB] = [state.physicsRenderTargetB, state.physicsRenderTargetA];

            if (state.copyMaterial.uniforms.uTexture.value) {
                state.renderer.setRenderTarget(state.sceneRenderTarget);
                state.renderer.render(state.copyScene, state.camera);
                state.renderer.setRenderTarget(state.blurRenderTargetDownsampledA);
                state.blurMaterial.uniforms.uInput.value = state.sceneRenderTarget.texture;
                state.blurMaterial.uniforms.uDirection.value.set(1.0, 0.0);
                state.renderer.render(state.blurScene, state.camera);
                state.renderer.setRenderTarget(state.blurRenderTargetDownsampledB);
                state.blurMaterial.uniforms.uInput.value = state.blurRenderTargetDownsampledA.texture;
                state.blurMaterial.uniforms.uDirection.value.set(0.0, 1.0);
                state.renderer.render(state.blurScene, state.camera);
                state.renderer.setRenderTarget(null);
                state.material.uniforms.uPhysicsState.value = state.physicsRenderTargetA.texture;
                state.material.uniforms.uSceneTexture.value = state.sceneRenderTarget.texture;
                state.material.uniforms.uBlurredMap.value = state.blurRenderTargetDownsampledB.texture;
                state.renderer.render(state.scene, state.camera);
            } else {
                state.renderer.setRenderTarget(null);
                state.renderer.clear();
            }
        };
        animate();

        return () => {
            if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
            state.renderer?.dispose();
            state.geometry?.dispose();
            state.material?.dispose();
            state.copyMaterial?.uniforms.uTexture.value?.dispose();
            state.copyMaterial?.dispose();
            state.physicsMaterial?.dispose();
            state.blurMaterial?.dispose();
            state.physicsRenderTargetA?.dispose();
            state.physicsRenderTargetB?.dispose();
            state.sceneRenderTarget?.dispose();
            state.blurRenderTargetDownsampledA?.dispose();
            state.blurRenderTargetDownsampledB?.dispose();
        };
    }, []);

    // Effect for handling component resizes.
    useLayoutEffect(() => {
        const state = threeState.current;
        if (state.renderer && state.scene && state.copyMaterial && state.physicsMaterial && state.blurMaterial && width > 0 && height > 0) {
            state.renderer.setSize(width, height, false);
            const downsampledWidth = Math.round(width / DOWNSAMPLE_FACTOR);
            const downsampledHeight = Math.round(height / DOWNSAMPLE_FACTOR);
            (state.scene.children[0] as THREE.Mesh<any, THREE.ShaderMaterial>).material.uniforms.uResolution.value.set(width, height);
            state.copyMaterial.uniforms.uResolution.value.set(width, height);
            state.physicsMaterial.uniforms.uResolution.value.set(width, height);
            state.physicsMaterial.uniforms.uBrushSize.value = Math.min(width, height) * 0.15;
            state.blurMaterial.uniforms.uResolution.value.set(downsampledWidth, downsampledHeight);
            state.physicsRenderTargetA.setSize(width, height);
            state.physicsRenderTargetB.setSize(width, height);
            state.sceneRenderTarget.setSize(width, height);
            state.blurRenderTargetDownsampledA.setSize(downsampledWidth, downsampledHeight);
            state.blurRenderTargetDownsampledB.setSize(downsampledWidth, downsampledHeight);
        }
    }, [width, height]);

    // Effect for loading the texture from either an image URL or by capturing children.
    useEffect(() => {
        const { copyMaterial } = threeState.current;
        if (!copyMaterial) return;

        let isCancelled = false;
        const textureLoader = new THREE.TextureLoader();
        let objectURL: string | null = null;
        
        const loadAndUpdateTexture = async () => {
            try {
                let texture: THREE.Texture | null = null;
                
                if (useContentAsTexture) {
                    if (!contentCaptureRef.current || !children || debouncedWidth <= 0 || debouncedHeight <= 0) {
                        return;
                    }
                    const contentCanvas = await html2canvas(contentCaptureRef.current, { 
                        backgroundColor: null, useCORS: true, scale: window.devicePixelRatio,
                        width: width, height: height,
                    });
                    if (isCancelled) return;
                    texture = new THREE.CanvasTexture(contentCanvas);
                } else if (imageUrl) {
                    const response = await fetch(imageUrl, { mode: 'cors' });
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    if (isCancelled) return;
                    const blob = await response.blob();
                    objectURL = URL.createObjectURL(blob);
                    if (isCancelled) return;
                    texture = await textureLoader.loadAsync(objectURL);
                }

                if (isCancelled || !texture) {
                    if (copyMaterial.uniforms.uTexture.value) {
                        copyMaterial.uniforms.uTexture.value = null;
                    }
                    return;
                }

                if (copyMaterial.uniforms.uTexture.value) {
                    copyMaterial.uniforms.uTexture.value.dispose();
                }

                texture.colorSpace = THREE.SRGBColorSpace;
                const imageRes = new THREE.Vector2(texture.image.width, texture.image.height);
                copyMaterial.uniforms.uTexture.value = texture;
                copyMaterial.uniforms.uImageResolution.value.copy(imageRes);

            } catch (error) {
                console.error("Failed to load texture:", error);
                if (copyMaterial.uniforms.uTexture.value) {
                    copyMaterial.uniforms.uTexture.value = null;
                }
            }
        };

        loadAndUpdateTexture();

        return () => {
            isCancelled = true;
            if (objectURL) URL.revokeObjectURL(objectURL);
        };
    }, [imageUrl, useContentAsTexture, children, debouncedWidth, debouncedHeight]);

    const contentCaptureStyle: CSSProperties = {
        position: 'absolute',
        top: 0,
        left: 0,
        transform: 'translateX(-101%)', // More robust off-screen positioning
        width: width,
        height: height,
        pointerEvents: 'none',
        visibility: useContentAsTexture ? 'visible' : 'hidden',
    };

    return (
        <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
            <canvas
                ref={canvasRef}
                style={{ width: "100%", height: "100%", display: "block" }}
            />
            <div ref={contentCaptureRef} style={contentCaptureStyle}>
                {children}
            </div>
        </div>
    )
}

Goo.defaultProps = {
    width: 1200,
    height: 675
};

// FIX: Removed `framer.` prefix and used direct import.
addPropertyControls(Goo, {
    useContentAsTexture: {
        // FIX: Removed `framer.` prefix.
        type: ControlType.Boolean,
        title: "Source",
        defaultValue: false,
        enabledTitle: "Content",
        disabledTitle: "Image",
    },
    children: {
        // FIX: Removed `framer.` prefix.
        type: ControlType.ComponentInstance,
        title: "Content",
        hidden: (props) => !props.useContentAsTexture,
    },
    imageUrl: {
        // FIX: Removed `framer.` prefix.
        type: ControlType.Image,
        title: "Image",
        defaultValue:
            "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=2070&auto=format&fit=crop",
        hidden: (props) => props.useContentAsTexture,
    },
    refrostRate: {
        // FIX: Removed `framer.` prefix.
        type: ControlType.Number,
        title: "Refrost Rate",
        defaultValue: 0.0004,
        min: 0,
        max: 0.01,
        step: 0.0001,
        display: "slider",
    },
});