



import React, { useRef, useEffect, useCallback, useState, RefObject } from 'react';
import * as THREE from 'three';
//@ts-ignore
import { addPropertyControls, ControlType } from 'framer';

// --- Shaders ---
const vertexShader = `
  precision mediump float;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const physicsFragmentShader = `
  precision mediump float;
  uniform sampler2D uPreviousFrame; // r: clear, g: water, b: drip
  uniform vec2 uResolution;
  uniform vec2 uMouse;
  uniform float uBrushSize;
  uniform float uRefrostRate;
  uniform float uIsMouseActive;
  varying vec2 vUv;

  #define DRIP_RETENTION 0.985
  #define WATER_EVAPORATION 0.97
  #define WATER_TO_DRIP_CONVERSION 0.01
  #define DRIP_CLEAR_FACTOR 0.9
  #define DRIP_OFFSET_PIXELS 2.0
  #define FROST_TO_WATER_CONVERSION 0.5

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
    float frostRemoved = max(0.0, (newClear - clear) * FROST_TO_WATER_CONVERSION); // How much frost was cleared this frame
    water += frostRemoved; // Add the removed frost as water
    clear = newClear;

    // 2. Water coalesces and creates potential for drips
    drip += water * WATER_TO_DRIP_CONVERSION; // Water contributes to the drip amount

    // 3. Gravity pulls drips down (Advection)
    vec2 dripOffset = vec2(0.0, 1.0 / uResolution.y) * DRIP_OFFSET_PIXELS;
    float incomingDrip = texture2D(uPreviousFrame, vUv - dripOffset).b;
    drip = incomingDrip * DRIP_RETENTION;

    // 4. Drips clear a path in the frost
    clear = max(clear, drip * DRIP_CLEAR_FACTOR);
    
    // 5. Water evaporates/dries
    water *= WATER_EVAPORATION;

    // 6. Frost slowly returns in non-wet, non-wiped areas
    clear -= uRefrostRate * (1.0 - water);

    clear = clamp(clear, 0.0, 1.0);
    water = clamp(water, 0.0, 1.0);
    drip = clamp(drip, 0.0, 1.0);

    gl_FragColor = vec4(clear, water, drip, 1.0);
  }
`;

const copyFragmentShader = `
  precision mediump float;
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
`;

const blurFragmentShader = `
  precision mediump float;
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
  precision mediump float;
  uniform vec2 uResolution;
  uniform sampler2D uSceneTexture;
  uniform sampler2D uPhysicsState;
  uniform sampler2D uBlurredMap;
  uniform vec2 uMouse;
  uniform float uBrushSize;
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

    // Add water highlights
    finalColor += pow(waterFactor, 2.0) * 0.15 + pow(dripFactor, 2.0) * 0.1;

    // Add pointer sheen
    float sheen = 1.0 - smoothstep(0.0, uBrushSize * 1.5, distance(gl_FragCoord.xy, uMouse));
    finalColor += sheen * 0.05 * (waterFactor + dripFactor);

    // Add noise to frosted areas
    float noise = (rand(vUv * 2.0) - 0.5) * 0.04;
    finalColor += noise * (1.0 - revealFactor);

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// --- WebGL Controller Class ---
class ClarityController {
    private canvas: HTMLCanvasElement;
    private renderer: THREE.WebGLRenderer;
    private camera: THREE.OrthographicCamera;
    
    private mainScene: THREE.Scene;
    private mainMaterial: THREE.ShaderMaterial;
    
    private copyScene: THREE.Scene;
    private copyMaterial: THREE.ShaderMaterial;

    private physicsScene: THREE.Scene;
    private physicsMaterial: THREE.ShaderMaterial;

    private blurScene: THREE.Scene;
    private blurMaterial: THREE.ShaderMaterial;

    private planeGeometry: THREE.PlaneGeometry;

    private physicsRenderTargetA: THREE.WebGLRenderTarget;
    private physicsRenderTargetB: THREE.WebGLRenderTarget;
    private sceneRenderTarget: THREE.WebGLRenderTarget;
    private blurRenderTargetA: THREE.WebGLRenderTarget;
    private blurRenderTargetB: THREE.WebGLRenderTarget;

    private mousePosition = new THREE.Vector2(-1000, -1000);
    private smoothedMouse = new THREE.Vector2(-1000, -1000);
    private isMouseActive = false;

    private mediaState = { type: '', src: '', loading: false };
    private videoElement: HTMLVideoElement | null = null;
    
    private isCancelled = false;
    private animationFrameId: number | null = null;
    private static DOWNSAMPLE_FACTOR = 8;
    private static PHYSICS_DOWNSAMPLE_FACTOR = 4;
    private isReady = false;
    private loadMediaRequestId = 0;
    
    private currentBrushSize = 0.30;
    private onError: (message: string | null) => void;
    
    private static MAX_TEXTURE_SIZE = 2048;

    constructor(canvas: HTMLCanvasElement, onError: (message: string | null) => void) {
        this.canvas = canvas;
        this.onError = onError;
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: false,
            alpha: true,
            powerPreference: 'low-power',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.planeGeometry = new THREE.PlaneGeometry(2, 2);

        this.mainMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uResolution: { value: new THREE.Vector2() }, uSceneTexture: { value: null }, uPhysicsState: { value: null }, uBlurredMap: { value: null }, uMouse: { value: new THREE.Vector2() }, uBrushSize: { value: 120.0 } } });
        this.mainScene = new THREE.Scene();
        this.mainScene.add(new THREE.Mesh(this.planeGeometry, this.mainMaterial));

        this.copyMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: copyFragmentShader, uniforms: { uTexture: { value: null }, uResolution: { value: new THREE.Vector2() }, uImageResolution: { value: new THREE.Vector2() } } });
        this.copyScene = new THREE.Scene();
        this.copyScene.add(new THREE.Mesh(this.planeGeometry, this.copyMaterial));
        
        this.physicsMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: physicsFragmentShader, uniforms: { uPreviousFrame: { value: null }, uResolution: { value: new THREE.Vector2() }, uMouse: { value: new THREE.Vector2() }, uBrushSize: { value: 120.0 }, uRefrostRate: { value: 0.0030 }, uIsMouseActive: { value: 0.0 } } });
        this.physicsScene = new THREE.Scene();
        this.physicsScene.add(new THREE.Mesh(this.planeGeometry, this.physicsMaterial));
        
        this.blurMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: blurFragmentShader, uniforms: { uInput: { value: null }, uResolution: { value: new THREE.Vector2() }, uDirection: { value: new THREE.Vector2() } } });
        this.blurScene = new THREE.Scene();
        this.blurScene.add(new THREE.Mesh(this.planeGeometry, this.blurMaterial));

        const renderTargetOptions = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, stencilBuffer: false };
        this.physicsRenderTargetA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.physicsRenderTargetB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.sceneRenderTarget = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.blurRenderTargetA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.blurRenderTargetB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        
        this.start();
    }
    
    public setRefrostRate(rate: number) { this.physicsMaterial.uniforms.uRefrostRate.value = rate; }
    public updatePointer(x: number, y: number, isActive: boolean) {
        this.isMouseActive = isActive;
        if (isActive) { this.mousePosition.set(x, y); }
    }
    public updateBrushSize(brushSize: number) {
        this.currentBrushSize = brushSize;
        if (!this.isReady) return;
        const size = new THREE.Vector2();
        this.renderer.getSize(size);
        const brushPixelSize = Math.min(size.x, size.y) * brushSize;
        this.mainMaterial.uniforms.uBrushSize.value = brushPixelSize;
        this.physicsMaterial.uniforms.uBrushSize.value = brushPixelSize / ClarityController.PHYSICS_DOWNSAMPLE_FACTOR;
    }
    public resize = (width: number, height: number) => {
        if (width <= 0 || height <= 0) {
            if (this.isReady) console.log('Clarity: Canvas size is zero, pausing render.');
            this.isReady = false;
            return;
        }

        if (!this.isReady) console.log(`Clarity: Canvas resized to ${width}x${height}, starting render.`);
        this.isReady = true;

        this.renderer.setSize(width, height, false);
        this.camera.updateProjectionMatrix();

        const downsampledWidth = Math.max(1, Math.round(width / ClarityController.DOWNSAMPLE_FACTOR));
        const downsampledHeight = Math.max(1, Math.round(height / ClarityController.DOWNSAMPLE_FACTOR));
        
        const physicsWidth = Math.max(1, Math.round(width / ClarityController.PHYSICS_DOWNSAMPLE_FACTOR));
        const physicsHeight = Math.max(1, Math.round(height / ClarityController.PHYSICS_DOWNSAMPLE_FACTOR));

        this.updateBrushSize(this.currentBrushSize);
        
        this.mainMaterial.uniforms.uResolution.value.set(width, height);
        this.copyMaterial.uniforms.uResolution.value.set(width, height);
        this.physicsMaterial.uniforms.uResolution.value.set(physicsWidth, physicsHeight);
        this.blurMaterial.uniforms.uResolution.value.set(downsampledWidth, downsampledHeight);
        
        this.physicsRenderTargetA.setSize(physicsWidth, physicsHeight);
        this.physicsRenderTargetB.setSize(physicsWidth, physicsHeight);
        this.sceneRenderTarget.setSize(width, height);
        this.blurRenderTargetA.setSize(downsampledWidth, downsampledHeight);
        this.blurRenderTargetB.setSize(downsampledWidth, downsampledHeight);
    }
    
    private _cleanupPreviousMedia() {
        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.removeAttribute('src');
            this.videoElement.load();
            this.videoElement = null;
        }
        if (this.copyMaterial.uniforms.uTexture.value) {
            this.copyMaterial.uniforms.uTexture.value.dispose();
            this.copyMaterial.uniforms.uTexture.value = null;
        }
    }
    
    private async _loadImageTexture(imageUrl: string): Promise<{ texture: THREE.Texture, resolution: THREE.Vector2 }> {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin("Anonymous");
        const originalTexture = await loader.loadAsync(imageUrl).catch(err => {
             throw new Error(`Failed to load image. This may be a CORS issue or an invalid URL. Ensure the image is accessible. URL: ${imageUrl}`);
        });

        if (this.isCancelled) {
            originalTexture.dispose();
            throw new Error('Component unmounted during texture load');
        }

        const image = originalTexture.image as HTMLImageElement;
        let width = image.width;
        let height = image.height;

        if (width > ClarityController.MAX_TEXTURE_SIZE || height > ClarityController.MAX_TEXTURE_SIZE) {
            console.log(`Clarity: Downscaling image from ${width}x${height} to fit within ${ClarityController.MAX_TEXTURE_SIZE}px.`);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                console.warn("Clarity: Could not get 2D context for image resizing. Using original image.");
                const resolution = new THREE.Vector2(width, height);
                return { texture: originalTexture, resolution };
            }

            const aspectRatio = width / height;
            if (width > height) {
                canvas.width = ClarityController.MAX_TEXTURE_SIZE;
                canvas.height = Math.round(ClarityController.MAX_TEXTURE_SIZE / aspectRatio);
            } else {
                canvas.height = ClarityController.MAX_TEXTURE_SIZE;
                canvas.width = Math.round(ClarityController.MAX_TEXTURE_SIZE * aspectRatio);
            }

            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            
            originalTexture.dispose();
            
            const scaledTexture = new THREE.CanvasTexture(canvas);
            const resolution = new THREE.Vector2(canvas.width, canvas.height);
            return { texture: scaledTexture, resolution };

        } else {
            const resolution = new THREE.Vector2(width, height);
            return { texture: originalTexture, resolution };
        }
    }
    
    private async _loadVideoTexture(videoUrl: string): Promise<{ texture: THREE.VideoTexture, resolution: THREE.Vector2 }> {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            this.videoElement = video;

            const cleanup = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
            };

            const onCanPlay = () => {
                video.play()
                    .then(() => {
                        if (this.isCancelled) {
                            reject(new Error('Component unmounted'));
                            return;
                        }
                        const texture = new THREE.VideoTexture(video);
                        const resolution = new THREE.Vector2(video.videoWidth, video.videoHeight);
                        cleanup();
                        resolve({ texture, resolution });
                    })
                    .catch(err => {
                        cleanup();
                        reject(err);
                    });
            };

            const onError = (e: Event | string) => {
                cleanup();
                reject(new Error(`Failed to load video. This may be a CORS issue or an invalid URL. Ensure the video is accessible. URL: ${videoUrl}`));
            };

            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onError);

            video.crossOrigin = "Anonymous";
            video.src = videoUrl;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.load();
        });
    }

    public async loadMedia(mediaType: 'image' | 'video', imageUrl?: string, videoUrl?: string) {
        const type = mediaType;
        const src = type === 'image' ? imageUrl : videoUrl;
        
        if (!src || (this.mediaState.type === type && this.mediaState.src === src)) {
            return;
        }

        this.loadMediaRequestId++;
        const currentRequestId = this.loadMediaRequestId;
        this.mediaState = { loading: true, type, src };
        this.onError(null);
        this._cleanupPreviousMedia();

        try {
            let result: { texture: THREE.Texture, resolution: THREE.Vector2 };

            if (type === 'image' && imageUrl) {
                result = await this._loadImageTexture(imageUrl);
            } else if (type === 'video' && videoUrl) {
                result = await this._loadVideoTexture(videoUrl);
            } else {
                throw new Error("No valid media source provided.");
            }
            
            if (this.isCancelled || currentRequestId !== this.loadMediaRequestId) {
                 result.texture.dispose();
                 console.log("Clarity: Stale media load request ignored.");
                 return;
            }

            result.texture.colorSpace = THREE.SRGBColorSpace;
            this.copyMaterial.uniforms.uTexture.value = result.texture;
            this.copyMaterial.uniforms.uImageResolution.value.copy(result.resolution);
            
            // A resize is needed to recalculate cover UVs for the new media
            const size = new THREE.Vector2();
            this.renderer.getSize(size);
            this.resize(size.x, size.y);

        } catch (error) {
            if (this.isCancelled || currentRequestId !== this.loadMediaRequestId) {
                console.log("Clarity: Stale media load request failed, ignoring error.");
                return;
            }
            let errorMessage = "An unknown error occurred while loading media.";
            if (error instanceof Error) {
                errorMessage = error.message;
            } else {
                errorMessage = String(error);
            }
            
            console.error(`Clarity Component Error: ${errorMessage}`);
            this.onError(errorMessage);
            this._cleanupPreviousMedia();
        } finally {
            if (!this.isCancelled && currentRequestId === this.loadMediaRequestId) {
                this.mediaState.loading = false;
            }
        }
    }

    private _animate = () => {
        if (this.isCancelled) return;
        this.animationFrameId = requestAnimationFrame(this._animate);

        if (!this.isReady) return;

        this.smoothedMouse.lerp(this.mousePosition, 0.1);
        
        this.renderer.setRenderTarget(this.physicsRenderTargetB);
        this.physicsMaterial.uniforms.uPreviousFrame.value = this.physicsRenderTargetA.texture;
        
        const physicsMouse = this.smoothedMouse.clone().divideScalar(ClarityController.PHYSICS_DOWNSAMPLE_FACTOR);
        this.physicsMaterial.uniforms.uMouse.value.copy(physicsMouse);

        this.physicsMaterial.uniforms.uIsMouseActive.value = this.isMouseActive ? 1.0 : 0.0;
        this.renderer.render(this.physicsScene, this.camera);
        [this.physicsRenderTargetA, this.physicsRenderTargetB] = [this.physicsRenderTargetB, this.physicsRenderTargetA];

        if (this.copyMaterial.uniforms.uTexture.value) {
            this.renderer.setRenderTarget(this.sceneRenderTarget);
            this.renderer.render(this.copyScene, this.camera);
            
            this.renderer.setRenderTarget(this.blurRenderTargetA);
            this.blurMaterial.uniforms.uInput.value = this.sceneRenderTarget.texture;
            this.blurMaterial.uniforms.uDirection.value.set(1.0, 0.0);
            this.renderer.render(this.blurScene, this.camera);

            this.renderer.setRenderTarget(this.blurRenderTargetB);
            this.blurMaterial.uniforms.uInput.value = this.blurRenderTargetA.texture;
            this.blurMaterial.uniforms.uDirection.value.set(0.0, 1.0);
            this.renderer.render(this.blurScene, this.camera);
            
            this.renderer.setRenderTarget(null);
            this.mainMaterial.uniforms.uPhysicsState.value = this.physicsRenderTargetA.texture;
            this.mainMaterial.uniforms.uSceneTexture.value = this.sceneRenderTarget.texture;
            this.mainMaterial.uniforms.uBlurredMap.value = this.blurRenderTargetB.texture;
            this.mainMaterial.uniforms.uMouse.value.copy(this.smoothedMouse);
            this.renderer.render(this.mainScene, this.camera);
        } else {
            this.renderer.setRenderTarget(null);
            this.renderer.clear();
        }
    }
    
    public start() { this._animate(); }

    public dispose() {
        this.isCancelled = true;
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        
        this._cleanupPreviousMedia();
    
        // Dispose all THREE.js objects to free up GPU memory
        this.planeGeometry.dispose();
        this.mainMaterial.dispose();
        this.copyMaterial.dispose();
        this.physicsMaterial.dispose();
        this.blurMaterial.dispose();
        this.physicsRenderTargetA.dispose();
        this.physicsRenderTargetB.dispose();
        this.sceneRenderTarget.dispose();
        this.blurRenderTargetA.dispose();
        this.blurRenderTargetB.dispose();
    
        // Forcefully release the WebGL context.
        // This is crucial in development environments (like React with StrictMode)
        // where components can be mounted/unmounted rapidly, to prevent hitting
        // the browser's limit for active WebGL contexts.
        this.renderer.forceContextLoss();
        this.renderer.dispose();
    }
}

// --- Pointer Events Hook ---
const usePointerEvents = (
  canvasRef: RefObject<HTMLCanvasElement>,
  onPointerUpdate: (x: number, y: number, isActive: boolean) => void
) => {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updatePointerPosition = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = rect.height - (clientY - rect.top);
        onPointerUpdate(x, y, true);
    };

    const handleMouseMove = (event: MouseEvent) => updatePointerPosition(event.clientX, event.clientY);
    const handleMouseLeave = () => onPointerUpdate(0, 0, false);
    const handleTouchMove = (event: TouchEvent) => { if (event.touches.length > 0) updatePointerPosition(event.touches[0].clientX, event.touches[0].clientY); };
    const handleTouchEnd = () => onPointerUpdate(0, 0, false);
    
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
    };
  }, [canvasRef, onPointerUpdate]);
};

// --- Main Framer Component ---
export interface ClarityProps {
  mediaType: 'image' | 'video';
  imageUrl?: string;
  videoUrl?: string;
  refrostRate: number;
  brushSize: number;
  width?: number;
  height?: number;
}

/**
 * @framerSupportedLayoutWidth auto
 * @framerSupportedLayoutHeight auto
 */
function Clarity(props: ClarityProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<ClarityController | null>(null);
  const [error, setError] = useState<string | null>(null);

  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });
  
  const handleError = useCallback((message: string | null) => {
    setError(message);
  }, []);

  const handleResize = useCallback(() => {
    const controller = controllerRef.current;
    const canvas = canvasRef.current;
    if (!controller || !canvas || !canvas.parentElement) return;

    const parent = canvas.parentElement;
    const currentProps = propsRef.current;
    
    const width = currentProps.width ?? parent.clientWidth;
    const height = currentProps.height ?? parent.clientHeight;
    
    controller.resize(width, height);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.parentElement) return;
    
    const parent = canvas.parentElement;
    const controller = new ClarityController(canvas, handleError);
    controllerRef.current = controller;

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(parent);
    
    handleResize(); // Perform initial resize
    
    return () => {
      resizeObserver.disconnect();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [handleError, handleResize]);

  useEffect(() => {
    handleResize();
  }, [props.width, props.height, handleResize]);

  useEffect(() => {
    controllerRef.current?.setRefrostRate(props.refrostRate);
  }, [props.refrostRate]);

  useEffect(() => {
    controllerRef.current?.updateBrushSize(props.brushSize);
  }, [props.brushSize]);

  useEffect(() => {
    controllerRef.current?.loadMedia(props.mediaType, props.imageUrl, props.videoUrl);
  }, [props.mediaType, props.imageUrl, props.videoUrl]);

  const onPointerUpdate = useCallback((x: number, y: number, isActive: boolean) => {
    controllerRef.current?.updatePointer(x, y, isActive);
  }, []);

  usePointerEvents(canvasRef, onPointerUpdate);

  return (
    <div className="w-full h-full relative bg-black/20">
      <canvas 
        ref={canvasRef} 
        className="w-full h-full" 
        style={{ display: 'block', opacity: error ? 0.2 : 1, transition: 'opacity 0.3s' }} 
        aria-label="Interactive frosted glass pane" 
       />
      {error && (
        <div 
          className="absolute inset-0 flex flex-col items-center justify-center bg-transparent text-white p-6 text-center"
          role="alert"
        >
          <div className="max-w-md p-4 rounded-lg bg-black/50 backdrop-blur-sm border border-red-500/50">
            <h3 className="font-bold text-md mb-2 text-red-400">Component Error</h3>
            <p className="text-sm text-gray-300">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
};

Clarity.defaultProps = {
    mediaType: 'image',
    imageUrl: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=2070&auto=format&fit=crop",
    refrostRate: 0.0030,
    brushSize: 0.30,
};

addPropertyControls(Clarity, {
    mediaType: { type: ControlType.Enum, title: "Media", options: ['image', 'video'], defaultValue: 'image' },
    imageUrl: { type: ControlType.Image, title: "Image", hidden: (props: ClarityProps) => props.mediaType !== 'image' },
    videoUrl: { type: ControlType.File, title: "Video", allowedFileTypes: ['mp4', 'webm', 'mov'], hidden: (props: ClarityProps) => props.mediaType !== 'video' },
    refrostRate: { type: ControlType.Number, title: "Refrost Rate", min: 0, max: 0.005, step: 0.0001, defaultValue: 0.0030, displayStepper: true },
    brushSize: { type: ControlType.Number, title: "Pointer Size", min: 0.05, max: 0.5, step: 0.01, defaultValue: 0.30, displayStepper: true },
});

export default Clarity;

// --- Standalone App Wrapper with UI Controls ---
export function ClarityApp() {
    const [brushSize, setBrushSize] = useState(0.30);
    const [refrostRate, setRefrostRate] = useState(0.0030);

    return (
        <div className="w-screen h-screen text-white flex flex-col items-center justify-center overflow-hidden">
            <div className="absolute top-4 left-4 sm:top-6 sm:left-6 p-4 z-10 w-[calc(100%-2rem)] max-w-sm animate-fade-in-up">
                <div className="p-4 bg-black/40 backdrop-blur-lg rounded-xl border border-white/10 shadow-2xl space-y-4">
                    <h1 className="text-xl font-medium text-center">Clarity Controls</h1>
                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <label htmlFor="brushSize" className="text-sm font-medium text-gray-300">Pointer Size</label>
                          <span className="text-sm text-gray-400 font-mono bg-white/10 px-2 py-1 rounded">{brushSize.toFixed(2)}</span>
                        </div>
                        <input
                            id="brushSize"
                            type="range"
                            min="0.05"
                            max="0.5"
                            step="0.01"
                            value={brushSize}
                            onChange={(e) => setBrushSize(parseFloat(e.target.value))}
                            className="w-full custom-slider"
                            aria-label="Pointer Size"
                        />
                    </div>
                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <label htmlFor="refrostRate" className="text-sm font-medium text-gray-300">Refrost Rate</label>
                           <span className="text-sm text-gray-400 font-mono bg-white/10 px-2 py-1 rounded">{refrostRate.toFixed(4)}</span>
                        </div>
                        <input
                            id="refrostRate"
                            type="range"
                            min="0"
                            max="0.005"
                            step="0.0001"
                            value={refrostRate}
                            onChange={(e) => setRefrostRate(parseFloat(e.target.value))}
                            className="w-full custom-slider"
                            aria-label="Refrost Rate"
                        />
                    </div>
                </div>
            </div>
            <div className="w-full h-full animate-fade-in absolute inset-0">
                <Clarity
                    mediaType="image"
                    imageUrl="https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=2070&auto=format&fit=crop"
                    brushSize={brushSize}
                    refrostRate={refrostRate}
                />
            </div>
        </div>
    );
}