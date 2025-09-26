

import React, { useState, useRef, useEffect } from 'react';
import * as THREE from 'three';

// --- SHADER DEFINITIONS ---

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
  uniform float uTime; // For animated grain

  varying vec2 vUv;

  // Simple pseudo-random function
  float rand(vec2 n) { 
    return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
  }

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

    // Add a subtle, animated grainy noise overlay that fades in cleared areas
    float noise = (rand(vUv * 2.0 + uTime) - 0.5) * 0.04;
    finalColor += noise * (1.0 - revealFactor);

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;


export default function Clarity(props) {
  const [refrostRate, setRefrostRate] = useState(0.0004);
  const [mediaType, setMediaType] = useState('image');
  const [brushSize, setBrushSize] = useState(0.15);

  const imageUrl = "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=2070&auto=format&fit=crop";
  const videoUrl = "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
  
  const canvasRef = useRef(null);
  const mousePosition = useRef({ x: -1000, y: -1000 });
  const isMouseActive = useRef(false);
  const physicsMaterialRef = useRef(null);
  const brushSizeRef = useRef(brushSize);

  useEffect(() => {
    brushSizeRef.current = brushSize;
  }, [brushSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const material = physicsMaterialRef.current;
    const parent = canvas?.parentElement;
    if (material && parent) {
      const { clientWidth: width, clientHeight: height } = parent;
      material.uniforms.uBrushSize.value = Math.min(width, height) * brushSize;
    }
  }, [brushSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateMousePosition = (clientX, clientY) => {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        if (!isMouseActive.current) isMouseActive.current = true;
        mousePosition.current = {
            x: clientX - rect.left,
            y: rect.height - (clientY - rect.top), // Flipped Y for WebGL coords
        };
    };

    const handleMouseMove = (event) => updateMousePosition(event.clientX, event.clientY);
    const handleMouseLeave = () => { isMouseActive.current = false; };
    const handleTouchMove = (event) => {
        if (event.touches.length > 0) {
            updateMousePosition(event.touches[0].clientX, event.touches[0].clientY);
        }
    };
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
    if (physicsMaterialRef.current) {
      physicsMaterialRef.current.uniforms.uRefrostRate.value = refrostRate;
    }
  }, [refrostRate]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const DOWNSAMPLE_FACTOR = 2;
    const clock = new THREE.Clock();
    
    const activeImageUrl = mediaType === 'image' ? imageUrl : undefined;
    const activeVideoUrl = mediaType === 'video' ? videoUrl : undefined;

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
        uTime: { value: 0.0 },
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
        physicsMaterial.uniforms.uBrushSize.value = Math.min(width, height) * brushSizeRef.current;
        blurMaterial.uniforms.uResolution.value.set(downsampledWidth, downsampledHeight);

        physicsRenderTargetA.setSize(width, height);
        physicsRenderTargetB.setSize(width, height);
        sceneRenderTarget.setSize(width, height);
        blurRenderTargetDownsampledA.setSize(downsampledWidth, downsampledHeight);
        blurRenderTargetDownsampledB.setSize(downsampledWidth, downsampledHeight);
      }
    };
    window.addEventListener('resize', handleResize);

    let animationFrameId;
    
    const animate = () => {
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
      
      animationFrameId = requestAnimationFrame(animate);
    };

    let isCancelled = false;
    let objectURL = null;
    let videoElement = null;

    const loadMediaAndStart = async () => {
      try {
        let texture;
        let mediaResolution;
        
        if (activeImageUrl) {
            const response = await fetch(activeImageUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            if (isCancelled) return;

            const blob = await response.blob();
            objectURL = URL.createObjectURL(blob);
            if (isCancelled) return;
            
            const textureLoader = new THREE.TextureLoader();
            const imageTexture = await textureLoader.loadAsync(objectURL);
            if (isCancelled) return;
            
            texture = imageTexture;
            mediaResolution = new THREE.Vector2(texture.image.width, texture.image.height);
        } else if (activeVideoUrl) {
            // FIX: Explicitly type Promise with <void> because it resolves with no value.
            await new Promise<void>((resolve, reject) => {
              videoElement = document.createElement('video');
              videoElement.src = activeVideoUrl;
              videoElement.crossOrigin = 'anonymous';
              videoElement.muted = true;
              videoElement.loop = true;
              videoElement.playsInline = true;

              const onCanPlay = () => {
                videoElement.play().then(() => {
                  if (isCancelled) return;
                  texture = new THREE.VideoTexture(videoElement);
                  mediaResolution = new THREE.Vector2(videoElement.videoWidth, videoElement.videoHeight);
                  cleanupListeners();
                  resolve();
                }).catch(reject);
              };

              const onError = () => {
                cleanupListeners();
                reject(new Error('Failed to load video. The source may be unsupported or blocked.'));
              };
              
              const cleanupListeners = () => {
                  videoElement?.removeEventListener('canplay', onCanPlay);
                  videoElement?.removeEventListener('error', onError);
              };

              videoElement.addEventListener('canplay', onCanPlay);
              videoElement.addEventListener('error', onError);
              videoElement.load();
            });
        } else {
            return;
        }

        if (isCancelled) return;

        texture.colorSpace = THREE.SRGBColorSpace;
        copyMaterial.uniforms.uTexture.value = texture;
        copyMaterial.uniforms.uImageResolution.value.copy(mediaResolution);
        
        handleResize();
        if (!animationFrameId) animate();

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Failed to load media:', errorMessage);
      }
    };

    loadMediaAndStart();

    return () => {
      isCancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
      if (videoElement) {
        videoElement.pause();
        videoElement.removeAttribute('src');
      }
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
  }, [mediaType]);

  // --- STYLES ---

  const buttonBaseStyle = { 
    padding: '0.25rem 1rem', 
    fontSize: '0.875rem', 
    lineHeight: '1.25rem', 
    borderRadius: '0.375rem', 
    transition: 'background-color 0.2s, color 0.2s',
    border: 'none',
    cursor: 'pointer'
  };
  const activeButtonStyle = { ...buttonBaseStyle, backgroundColor: '#FFFFFF', color: '#000000', fontWeight: 500 };
  const inactiveButtonStyle = { ...buttonBaseStyle, backgroundColor: 'rgba(255, 255, 255, 0.1)', color: '#FFFFFF' };

  return (
    <>
        <style>{`
          body {
            font-family: 'Inter', sans-serif;
            background: radial-gradient(ellipse at center, #2a2a2e 0%, #1a1a1a 70%);
            color: white;
            margin: 0;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: scale(0.98); }
            to { opacity: 1; transform: scale(1); }
          }
          @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(15px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .animate-fade-in {
            opacity: 0;
            animation: fadeIn 1s cubic-bezier(0.22, 1, 0.36, 1) 0.5s forwards;
          }
          .animate-fade-in-up {
            opacity: 0;
            animation: fadeInUp 0.8s cubic-bezier(0.22, 1, 0.36, 1) 0.2s forwards;
          }

          /* Custom Slider Styles */
          .custom-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 4px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 2px;
            outline: none;
            transition: background 0.3s;
          }
          .custom-slider:hover {
            background: rgba(255, 255, 255, 0.3);
          }
          .custom-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 16px;
            height: 16px;
            background: #ffffff;
            cursor: pointer;
            border-radius: 50%;
            box-shadow: 0 0 5px rgba(255, 255, 255, 0.5);
            transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
          }
          .custom-slider::-moz-range-thumb {
            width: 16px;
            height: 16px;
            background: #ffffff;
            cursor: pointer;
            border-radius: 50%;
            border: none;
            box-shadow: 0 0 5px rgba(255, 255, 255, 0.5);
             transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
          }
          .custom-slider:active::-webkit-slider-thumb {
            transform: scale(1.2);
          }
          .custom-slider:active::-moz-range-thumb {
            transform: scale(1.2);
          }
          .hide-on-small { display: none; } 
          @media (min-width: 640px) { .hide-on-small { display: inline; } }
        `}</style>
        <main style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', width: '100%', padding: '1rem', overflow: 'hidden' }}>
          
          <div className="animate-fade-in-up" style={{ zIndex: 10, textAlign: 'center', marginBottom: '2rem', padding: '0 1rem' }}>
            <h1 style={{ fontSize: '3.75rem', lineHeight: 1, fontWeight: 300, letterSpacing: '0.05em', color: '#E5E7EB', marginBottom: '0.5rem', textShadow: '0 2px 20px rgba(0,0,0,0.5)'}}>
              Clarity
            </h1>
            <p style={{ fontSize: '1.25rem', lineHeight: '1.75rem', color: '#9CA3AF', maxWidth: '42rem', margin: '0 auto', fontWeight: 300, textShadow: '0 2px 20px rgba(0,0,0,0.5)'}}>
              A winter morning. Wipe the frost away and watch as condensation drips down the pane.
            </p>
          </div>

          <div className="animate-fade-in" style={{ position: 'relative', width: '100%', maxWidth: '56rem', aspectRatio: '16 / 9', boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.25)', borderRadius: '0.5rem', overflow: 'hidden' }}>
             <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
            <div style={{ position: 'absolute', inset: 0, border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '0.5rem', pointerEvents: 'none' }}></div>
          </div>
          
          <div 
            className="animate-fade-in-up"
            style={{ zIndex: 10, marginTop: '2rem', width: '100%', maxWidth: '28rem', textAlign: 'center', padding: '1rem', borderRadius: '0.75rem', border: '1px solid rgba(255, 255, 255, 0.1)', backgroundColor: 'rgba(0, 0, 0, 0.2)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', animationDelay: '0.6s' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <label htmlFor="refrost-slider" style={{ flexShrink: 0, fontSize: '0.875rem', fontWeight: 500, color: '#D1D5DB', letterSpacing: '0.025em' }}>
                    Refrost <span className="hide-on-small">Rate</span>
                </label>
                <input
                  id="refrost-slider"
                  type="range"
                  min="0"
                  max="0.005"
                  step="0.0001"
                  value={refrostRate}
                  onChange={(e) => setRefrostRate(parseFloat(e.target.value))}
                  className="custom-slider"
                  aria-label="Refrost Rate Slider"
                />
                <span style={{ fontSize: '0.875rem', color: '#9CA3AF', fontFamily: 'monospace', width: '4rem', textAlign: 'right' }}>{Number(refrostRate).toFixed(4)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                <label htmlFor="brush-slider" style={{ flexShrink: 0, fontSize: '0.875rem', fontWeight: 500, color: '#D1D5DB', letterSpacing: '0.025em' }}>
                    Pointer <span className="hide-on-small">Size</span>
                </label>
                <input
                  id="brush-slider"
                  type="range"
                  min="0.05"
                  max="0.5"
                  step="0.01"
                  value={brushSize}
                  onChange={(e) => setBrushSize(parseFloat(e.target.value))}
                  className="custom-slider"
                  aria-label="Pointer Size Slider"
                />
                <span style={{ fontSize: '0.875rem', color: '#9CA3AF', fontFamily: 'monospace', width: '4rem', textAlign: 'right' }}>{Number(brushSize).toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                 <label style={{ flexShrink: 0, fontSize: '0.875rem', fontWeight: 500, color: '#D1D5DB', letterSpacing: '0.025em' }}>
                    Background
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button 
                        onClick={() => setMediaType('image')} 
                        style={mediaType === 'image' ? activeButtonStyle : inactiveButtonStyle}
                        aria-pressed={mediaType === 'image'}
                    >
                        Image
                    </button>
                    <button 
                        onClick={() => setMediaType('video')}
                        style={mediaType === 'video' ? activeButtonStyle : inactiveButtonStyle}
                        aria-pressed={mediaType === 'video'}
                    >
                        Video
                    </button>
                </div>
            </div>
          </div>
        </main>
    </>
  );
};