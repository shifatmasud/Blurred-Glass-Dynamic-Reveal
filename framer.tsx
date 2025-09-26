import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
//@ts-ignore
import { addPropertyControls, ControlType } from 'framer';

interface ClarityProps {
  mediaType: 'image' | 'video';
  imageUrl?: string;
  videoUrl?: string;
  refrostRate: number;
  brushSize: number;
  width: number;
  height: number;
}

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

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

    // 1. Wiping converts frost to water
    float brush = 0.0;
    if (uIsMouseActive > 0.5) {
      float dist = distance(gl_FragCoord.xy, uMouse);
      brush = 1.0 - smoothstep(0.0, uBrushSize, dist);
    }
    
    float newClear = max(clear, brush);
    float frostRemoved = max(0.0, (newClear - clear) * 0.5); // How much frost was cleared this frame
    water += frostRemoved; // Add the removed frost as water
    clear = newClear;

    // 2. Water coalesces and creates potential for drips
    drip += water * 0.01; // Water contributes to the drip amount

    // 3. Gravity pulls drips down (Advection)
    // Sample from the pixel directly above to see if it was dripping
    vec2 dripOffset = vec2(0.0, 1.0 / uResolution.y) * 2.0; // Move down 2 pixels
    float incomingDrip = texture2D(uPreviousFrame, vUv - dripOffset).b;
    drip = incomingDrip * 0.985; // Drips are advected downwards and slowly fade

    // 4. Drips clear a path in the frost
    clear = max(clear, drip * 0.9);
    
    // 5. Water evaporates/dries
    water *= 0.97;

    // 6. Frost slowly returns in non-wet, non-wiped areas
    clear -= uRefrostRate * (1.0 - water); // Frost returns slower on wet areas

    // Clamp all values
    clear = clamp(clear, 0.0, 1.0);
    water = clamp(water, 0.0, 1.0);
    drip = clamp(drip, 0.0, 1.0);

    gl_FragColor = vec4(clear, water, drip, 1.0);
  }
`;

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
              // Canvas is wider than the image, so we fit the image's width and crop the top/bottom.
              float scale = imageAspect / canvasAspect;
              st.y = st.y * scale + (1.0 - scale) / 2.0;
          } else {
              // Canvas is taller than the image, so we fit the image's height and crop the sides.
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
`;

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
`;

const fragmentShader = `
  uniform vec2 uResolution;
  uniform sampler2D uSceneTexture;
  uniform sampler2D uPhysicsState;
  uniform sampler2D uBlurredMap;
  uniform float uTime;

  varying vec2 vUv;

  float rand(vec2 n) { 
    return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
  }

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
    float noise = (rand(vUv * 2.0) - 0.5) * 0.04;
    finalColor += noise * (1.0 - revealFactor);
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

export default function Clarity({ mediaType, imageUrl, videoUrl, refrostRate, brushSize, width, height }: Partial<ClarityProps>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mousePosition = useRef({ x: -1000, y: -1000 });
  const isMouseActive = useRef(false);

  const propsRef = useRef({ mediaType, imageUrl, videoUrl, refrostRate, brushSize, width, height });
  useEffect(() => {
    propsRef.current = { mediaType, imageUrl, videoUrl, refrostRate, brushSize, width, height };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateMousePosition = (clientX: number, clientY: number) => {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        if (!isMouseActive.current) isMouseActive.current = true;
        mousePosition.current = { x: clientX - rect.left, y: rect.height - (clientY - rect.top) };
    };
    const handleMouseMove = (event: MouseEvent) => updateMousePosition(event.clientX, event.clientY);
    const handleMouseLeave = () => { isMouseActive.current = false; };
    const handleTouchMove = (event: TouchEvent) => { if (event.touches.length > 0) updateMousePosition(event.touches[0].clientX, event.touches[0].clientY); };
    const handleTouchEnd = () => { isMouseActive.current = false; };
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('touchmove', handleTouchMove, { passive: true });
    canvas.addEventListener('touchend', handleTouchEnd);
    canvas.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    let isCancelled = false;

    const DOWNSAMPLE_FACTOR = 2;
    const clock = new THREE.Clock();
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uResolution: { value: new THREE.Vector2() }, uSceneTexture: { value: null }, uPhysicsState: { value: null }, uBlurredMap: { value: null }, uTime: { value: 0.0 } } });
    scene.add(new THREE.Mesh(geometry, material));
    const copyScene = new THREE.Scene();
    const copyMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: copyFragmentShader, uniforms: { uTexture: { value: null }, uResolution: { value: new THREE.Vector2() }, uImageResolution: { value: new THREE.Vector2() } } });
    copyScene.add(new THREE.Mesh(geometry, copyMaterial));
    const physicsScene = new THREE.Scene();
    const physicsMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: physicsFragmentShader, uniforms: { uPreviousFrame: { value: null }, uResolution: { value: new THREE.Vector2() }, uMouse: { value: new THREE.Vector2() }, uBrushSize: { value: 120.0 }, uRefrostRate: { value: 0.0004 }, uIsMouseActive: { value: 0.0 } } });
    physicsScene.add(new THREE.Mesh(geometry, physicsMaterial));
    const blurScene = new THREE.Scene();
    const blurMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: blurFragmentShader, uniforms: { uInput: { value: null }, uResolution: { value: new THREE.Vector2() }, uDirection: { value: new THREE.Vector2() } } });
    blurScene.add(new THREE.Mesh(geometry, blurMaterial));
    const renderTargetOptions = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType, stencilBuffer: false };
    let physicsRenderTargetA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    let physicsRenderTargetB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    let sceneRenderTarget = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    let blurRenderTargetDownsampledA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    let blurRenderTargetDownsampledB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    const mouseVector = new THREE.Vector2(-1000, -1000);

    const handleResize = () => {
        const { width, height, brushSize } = propsRef.current;
        const w = width ?? canvas.parentElement?.clientWidth ?? window.innerWidth;
        const h = height ?? canvas.parentElement?.clientHeight ?? window.innerHeight;
        renderer.setSize(w, h, false);
        camera.updateProjectionMatrix();
        const downsampledWidth = Math.round(w / DOWNSAMPLE_FACTOR);
        const downsampledHeight = Math.round(h / DOWNSAMPLE_FACTOR);
        material.uniforms.uResolution.value.set(w, h);
        copyMaterial.uniforms.uResolution.value.set(w, h);
        physicsMaterial.uniforms.uResolution.value.set(w, h);
        physicsMaterial.uniforms.uBrushSize.value = Math.min(w, h) * (brushSize ?? 0.15);
        blurMaterial.uniforms.uResolution.value.set(downsampledWidth, downsampledHeight);
        physicsRenderTargetA.setSize(w, h);
        physicsRenderTargetB.setSize(w, h);
        sceneRenderTarget.setSize(w, h);
        blurRenderTargetDownsampledA.setSize(downsampledWidth, downsampledHeight);
        blurRenderTargetDownsampledB.setSize(downsampledWidth, downsampledHeight);
    };
    
    let objectURL: string | null = null;
    let videoElement: HTMLVideoElement | null = null;
    const mediaState = {
        type: '',
        src: '',
        loading: false,
    };

    const loadMedia = async () => {
        const { mediaType, imageUrl, videoUrl } = propsRef.current;
        const type = mediaType ?? 'image';
        const src = type === 'image' ? imageUrl : videoUrl;
        
        if (!src) return;

        mediaState.loading = true;
        mediaState.type = type;
        mediaState.src = src;

        if (objectURL) URL.revokeObjectURL(objectURL); objectURL = null;
        if (videoElement) { videoElement.pause(); videoElement.removeAttribute('src'); videoElement = null; }
        copyMaterial.uniforms.uTexture.value?.dispose();
        copyMaterial.uniforms.uTexture.value = null;

        try {
            let texture: THREE.Texture;
            let mediaResolution: THREE.Vector2;
            if (type === 'image' && imageUrl) {
                const response = await fetch(imageUrl);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                if (isCancelled) return;
                const blob = await response.blob();
                objectURL = URL.createObjectURL(blob);
                if (isCancelled) return;
                const textureLoader = new THREE.TextureLoader();
                texture = await textureLoader.loadAsync(objectURL);
                if (isCancelled) return;
                mediaResolution = new THREE.Vector2(texture.image.width, texture.image.height);
            } else if (type === 'video' && videoUrl) {
                const result = await new Promise<{texture: THREE.VideoTexture, resolution: THREE.Vector2}>((resolve, reject) => {
                  videoElement = document.createElement('video');
                  videoElement.src = videoUrl;
                  videoElement.crossOrigin = 'anonymous'; videoElement.muted = true; videoElement.loop = true; videoElement.playsInline = true;
                  const onCanPlay = () => {
                    videoElement!.play().then(() => {
                        if (isCancelled) return;
                        const videoTexture = new THREE.VideoTexture(videoElement!);
                        const resolution = new THREE.Vector2(videoElement!.videoWidth, videoElement!.videoHeight);
                        cleanupListeners();
                        resolve({texture: videoTexture, resolution: resolution});
                    }).catch(reject);
                  };
                  const onError = () => { cleanupListeners(); reject(new Error('Failed to load video.')); };
                  const cleanupListeners = () => { videoElement?.removeEventListener('canplay', onCanPlay); videoElement?.removeEventListener('error', onError); };
                  videoElement.addEventListener('canplay', onCanPlay); videoElement.addEventListener('error', onError); videoElement.load();
                });
                texture = result.texture;
                mediaResolution = result.resolution;
            } else { return; }
            if (isCancelled) return;
            texture!.colorSpace = THREE.SRGBColorSpace;
            copyMaterial.uniforms.uTexture.value = texture!;
            copyMaterial.uniforms.uImageResolution.value.copy(mediaResolution!);
            handleResize();
        } catch (error) { console.error('Failed to load media:', error instanceof Error ? error.message : String(error)); }
        finally {
          mediaState.loading = false;
        }
    };
    
    let animationFrameId: number;
    const sizeVec = new THREE.Vector2();
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      const { mediaType, imageUrl, videoUrl, refrostRate, brushSize } = propsRef.current;
      const currentSrc = mediaType === 'image' ? imageUrl : videoUrl;
      if (!mediaState.loading && (mediaState.type !== mediaType || mediaState.src !== currentSrc)) {
          loadMedia();
      }

      renderer.getSize(sizeVec);
      physicsMaterial.uniforms.uRefrostRate.value = refrostRate ?? 0.0004;
      physicsMaterial.uniforms.uBrushSize.value = Math.min(sizeVec.x, sizeVec.y) * (brushSize ?? 0.15);
      mouseVector.lerp(mousePosition.current, 0.1);
      material.uniforms.uTime.value = clock.getElapsedTime();
      renderer.setRenderTarget(physicsRenderTargetB);
      physicsMaterial.uniforms.uPreviousFrame.value = physicsRenderTargetA.texture;
      physicsMaterial.uniforms.uMouse.value.copy(mouseVector);
      physicsMaterial.uniforms.uIsMouseActive.value = isMouseActive.current ? 1.0 : 0.0;
      renderer.render(physicsScene, camera);
      let tempPhysics = physicsRenderTargetA;
      physicsRenderTargetA = physicsRenderTargetB;
      physicsRenderTargetB = tempPhysics;
      if (copyMaterial.uniforms.uTexture.value) {
        renderer.setRenderTarget(sceneRenderTarget);
        renderer.render(copyScene, camera);
        renderer.setRenderTarget(blurRenderTargetDownsampledA);
        blurMaterial.uniforms.uInput.value = sceneRenderTarget.texture;
        blurMaterial.uniforms.uDirection.value.set(1.0, 0.0);
        renderer.render(blurScene, camera);
        renderer.setRenderTarget(blurRenderTargetDownsampledB);
        blurMaterial.uniforms.uInput.value = blurRenderTargetDownsampledA.texture;
        blurMaterial.uniforms.uDirection.value.set(0.0, 1.0);
        renderer.render(blurScene, camera);
        renderer.setRenderTarget(null);
        material.uniforms.uPhysicsState.value = physicsRenderTargetA.texture;
        material.uniforms.uSceneTexture.value = sceneRenderTarget.texture;
        material.uniforms.uBlurredMap.value = blurRenderTargetDownsampledB.texture;
        renderer.render(scene, camera);
      } else {
        renderer.setRenderTarget(null);
        renderer.clear();
      }
    };

    handleResize();
    animate();
    window.addEventListener('resize', handleResize);

    return () => {
      isCancelled = true;
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
      if (objectURL) URL.revokeObjectURL(objectURL);
      if (videoElement) { videoElement.pause(); videoElement.removeAttribute('src'); }
      renderer.dispose();
      geometry.dispose();
      copyMaterial.uniforms.uTexture.value?.dispose();
      copyMaterial.dispose();
      material.dispose();
      physicsMaterial.dispose();
      blurMaterial.dispose();
      physicsRenderTargetA.dispose();
      physicsRenderTargetB.dispose();
      sceneRenderTarget.dispose();
      blurRenderTargetDownsampledA.dispose();
      blurRenderTargetDownsampledB.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="w-full h-full" style={{ display: 'block' }} />;
};
//@ts-ignore
Clarity.defaultProps = {
    mediaType: 'image',
    imageUrl: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=2070&auto=format&fit=crop",
    refrostRate: 0.0004,
    brushSize: 0.15,
}

addPropertyControls(Clarity, {
    mediaType: {
        type: ControlType.Enum,
        title: "Media",
        options: ['image', 'video'],
        defaultValue: 'image',
    },
    imageUrl: {
        type: ControlType.Image,
        title: "Image",
        hidden: (props) => props.mediaType !== 'image',
    },
    videoUrl: {
        type: ControlType.File,
        title: "Video",
        allowedFileTypes: ['mp4', 'webm', 'mov'],
        hidden: (props) => props.mediaType !== 'video',
    },
    refrostRate: {
        type: ControlType.Number,
        title: "Refrost Rate",
        min: 0,
        max: 0.005,
        step: 0.0001,
        defaultValue: 0.0004,
        displayStepper: true,
    },
    brushSize: {
        type: ControlType.Number,
        title: "Pointer Size",
        min: 0.05,
        max: 0.5,
        step: 0.01,
        defaultValue: 0.15,
        displayStepper: true,
    },
});
