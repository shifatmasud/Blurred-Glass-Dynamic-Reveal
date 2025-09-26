
import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface GlassEffectProps {
  imageUrl: string;
  refrostRate: number;
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

  // Optimized 9-tap Gaussian blur using hardware bilinear filtering (5 texture reads).
  // This technique samples between pixels to achieve a higher quality result with fewer
  // texture fetches, which is crucial for eliminating grid-like artifacts.
  void main() {
    vec3 color = vec3(0.0);
    vec2 pixelSize = 1.0 / uResolution.xy;

    // Pre-calculated weights and offsets for an optimized Gaussian blur
    float weights[3] = float[](0.2270270270, 0.3162162162, 0.0702702703);
    float offsets[3] = float[](0.0, 1.3846153846, 3.2307692308);

    // Central sample
    color += texture2D(uInput, vUv).rgb * weights[0];

    // Symmetrical samples
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
  uniform sampler2D uSceneTexture; // The sharp, aspect-corrected scene
  uniform sampler2D uPhysicsState; // r: clear, g: water, b: drip
  uniform sampler2D uBlurredMap; // The final blurred scene

  varying vec2 vUv;

  void main() {
    vec4 physics = texture2D(uPhysicsState, vUv);
    float clearFactor = physics.r;
    float waterFactor = physics.g;
    float dripFactor = physics.b;

    // Create a disturbance map for refraction based on water and drips
    float disturbance = (waterFactor * 0.2 + dripFactor) * 0.5;
    
    // Use screen-space derivatives to get the gradient of the disturbance,
    // which simulates the edges of water refracting light.
    vec2 distortion = vec2(dFdx(disturbance), dFdy(disturbance)) * -10.0;

    // Smoothly reveal the sharp image based on how much has been cleared
    float revealFactor = smoothstep(0.0, 0.4, clearFactor);

    // Sample the background textures with the distortion offset
    vec3 sceneColor = texture2D(uSceneTexture, vUv + distortion).rgb;
    vec3 blurredColor = texture2D(uBlurredMap, vUv + distortion).rgb;
    
    // Mix between blurred and sharp based on the reveal factor
    vec3 finalColor = mix(blurredColor, sceneColor, revealFactor);

    // Add a subtle specular highlight to the water to make it look wet
    finalColor += pow(waterFactor, 2.0) * 0.15 + pow(dripFactor, 2.0) * 0.1;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;


const GlassEffect: React.FC<GlassEffectProps> = ({ imageUrl, refrostRate }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mousePosition = useRef({ x: -1000, y: -1000 });
  const isMouseActive = useRef(false);
  const physicsMaterialRef = useRef<THREE.ShaderMaterial | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!isMouseActive.current) isMouseActive.current = true;
      mousePosition.current = { x: event.clientX, y: event.clientY };
    };
    const handleMouseLeave = () => {
      isMouseActive.current = false;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length > 0) {
        if (!isMouseActive.current) isMouseActive.current = true;
        const touch = event.touches[0];
        mousePosition.current = { x: touch.clientX, y: touch.clientY };
      }
    };
    const handleTouchEnd = () => {
        isMouseActive.current = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    document.body.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('touchmove', handleTouchMove);
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('touchcancel', handleTouchEnd);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.body.removeEventListener('mouseleave', handleMouseLeave);
      window.addEventListener('touchmove', handleTouchMove);
      window.addEventListener('touchend', handleTouchEnd);
      window.addEventListener('touchcancel', handleTouchEnd);
    };
  }, []);

  useEffect(() => {
    if (physicsMaterialRef.current) {
      physicsMaterialRef.current.uniforms.uRefrostRate.value = refrostRate;
    }
  }, [refrostRate]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const DOWNSAMPLE_FACTOR = 2;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    
    const geometry = new THREE.PlaneGeometry(2, 2);
    
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uResolution: { value: new THREE.Vector2() },
        uSceneTexture: { value: null },
        uPhysicsState: { value: null },
        uBlurredMap: { value: null },
      },
    });
    scene.add(new THREE.Mesh(geometry, material));

    const copyScene = new THREE.Scene();
    const copyMaterial = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: copyFragmentShader,
        uniforms: {
            uTexture: { value: null },
            uResolution: { value: new THREE.Vector2() },
            uImageResolution: { value: new THREE.Vector2() },
        }
    });
    copyScene.add(new THREE.Mesh(geometry, copyMaterial));
    
    const physicsScene = new THREE.Scene();
    const physicsMaterial = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: physicsFragmentShader,
        uniforms: {
            uPreviousFrame: { value: null },
            uResolution: { value: new THREE.Vector2() },
            uMouse: { value: new THREE.Vector2() },
            uBrushSize: { value: 120.0 },
            uRefrostRate: { value: refrostRate },
            uIsMouseActive: { value: 0.0 },
        }
    });
    physicsMaterialRef.current = physicsMaterial;
    physicsScene.add(new THREE.Mesh(geometry, physicsMaterial));

    const blurScene = new THREE.Scene();
    const blurMaterial = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: blurFragmentShader,
        uniforms: {
            uInput: { value: null },
            uResolution: { value: new THREE.Vector2() },
            uDirection: { value: new THREE.Vector2() },
        }
    });
    blurScene.add(new THREE.Mesh(geometry, blurMaterial));

    const renderTargetOptions = { 
        minFilter: THREE.LinearFilter, 
        magFilter: THREE.LinearFilter, 
        format: THREE.RGBAFormat, 
        type: THREE.HalfFloatType,
        stencilBuffer: false
    };
    let physicsRenderTargetA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    let physicsRenderTargetB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    let sceneRenderTarget = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    // Downsampled render targets for high-quality blur
    let blurRenderTargetDownsampledA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    let blurRenderTargetDownsampledB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
    
    const mouseVector = new THREE.Vector2(-1000, -1000);

    const handleResize = () => {
      const parent = canvas.parentElement;
      if (parent) {
        const { clientWidth: width, clientHeight: height } = parent;
        renderer.setSize(width, height, false);
        camera.updateProjectionMatrix();

        const downsampledWidth = Math.round(width / DOWNSAMPLE_FACTOR);
        const downsampledHeight = Math.round(height / DOWNSAMPLE_FACTOR);

        material.uniforms.uResolution.value.set(width, height);
        copyMaterial.uniforms.uResolution.value.set(width, height);
        physicsMaterial.uniforms.uResolution.value.set(width, height);
        blurMaterial.uniforms.uResolution.value.set(downsampledWidth, downsampledHeight);

        physicsRenderTargetA.setSize(width, height);
        physicsRenderTargetB.setSize(width, height);
        sceneRenderTarget.setSize(width, height);
        blurRenderTargetDownsampledA.setSize(downsampledWidth, downsampledHeight);
        blurRenderTargetDownsampledB.setSize(downsampledWidth, downsampledHeight);
      }
    };
    window.addEventListener('resize', handleResize);

    let animationFrameId: number;
    
    const animate = () => {
      mouseVector.lerp(new THREE.Vector2(mousePosition.current.x, window.innerHeight - mousePosition.current.y), 0.1);
      
      // Physics pass
      renderer.setRenderTarget(physicsRenderTargetB);
      physicsMaterial.uniforms.uPreviousFrame.value = physicsRenderTargetA.texture;
      physicsMaterial.uniforms.uMouse.value.copy(mouseVector);
      physicsMaterial.uniforms.uIsMouseActive.value = isMouseActive.current ? 1.0 : 0.0;
      renderer.render(physicsScene, camera);
      let tempPhysics = physicsRenderTargetA;
      physicsRenderTargetA = physicsRenderTargetB;
      physicsRenderTargetB = tempPhysics;

      if (copyMaterial.uniforms.uTexture.value) {
        // Pass 1: Draw scene with aspect correction to a full-res texture
        renderer.setRenderTarget(sceneRenderTarget);
        renderer.render(copyScene, camera);

        // Pass 2: Horizontal Blur (on downsampled texture)
        renderer.setRenderTarget(blurRenderTargetDownsampledA);
        blurMaterial.uniforms.uInput.value = sceneRenderTarget.texture;
        blurMaterial.uniforms.uDirection.value.set(1.0, 0.0);
        renderer.render(blurScene, camera);

        // Pass 3: Vertical Blur (on downsampled texture)
        renderer.setRenderTarget(blurRenderTargetDownsampledB);
        blurMaterial.uniforms.uInput.value = blurRenderTargetDownsampledA.texture;
        blurMaterial.uniforms.uDirection.value.set(0.0, 1.0);
        renderer.render(blurScene, camera);

        // Final Render pass: Composite everything
        renderer.setRenderTarget(null);
        material.uniforms.uPhysicsState.value = physicsRenderTargetA.texture;
        material.uniforms.uSceneTexture.value = sceneRenderTarget.texture;
        material.uniforms.uBlurredMap.value = blurRenderTargetDownsampledB.texture;
        renderer.render(scene, camera);
      } else {
        renderer.setRenderTarget(null);
        renderer.clear();
      }
      
      animationFrameId = requestAnimationFrame(animate);
    };

    let isCancelled = false;
    let objectURL: string | null = null;

    const loadTextureAndStart = async () => {
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        if (isCancelled) return;

        const blob = await response.blob();
        objectURL = URL.createObjectURL(blob);
        if (isCancelled) return;
        
        const textureLoader = new THREE.TextureLoader();
        const texture = await textureLoader.loadAsync(objectURL);
        if (isCancelled) return;

        texture.colorSpace = THREE.SRGBColorSpace;
        const imageRes = new THREE.Vector2(texture.image.width, texture.image.height);
        
        copyMaterial.uniforms.uTexture.value = texture;
        copyMaterial.uniforms.uImageResolution.value.copy(imageRes);
        
        handleResize();
        if (!animationFrameId) animate();

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Failed to load texture:', errorMessage);
      }
    };

    loadTextureAndStart();
    animate();

    return () => {
      isCancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
      
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
  }, [imageUrl]);

  return <canvas ref={canvasRef} className="w-full h-full" />;
};

export default GlassEffect;
