import React, { useRef, useEffect, useCallback, useState } from 'react';
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
  refrostTrigger?: number;
  onError?: (message: string | null) => void; // Internal: for reporting errors to the React component
}

// --- Hook for abstracting pointer events ---
const usePointerEvents = (
  canvasRef: React.RefObject<HTMLCanvasElement>,
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
      canvas.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [canvasRef, onPointerUpdate]);
};


// --- Shaders ---
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
  uniform float uRefrostImpulse;
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
    vec2 dripOffset = vec2(0.0, 1.0 / uResolution.y) * 2.0; // Move down 2 pixels
    float incomingDrip = texture2D(uPreviousFrame, vUv - dripOffset).b;
    drip = incomingDrip * 0.985;

    // 4. Drips clear a path in the frost
    clear = max(clear, drip * 0.9);
    
    // 5. Water evaporates/dries
    water *= 0.97;

    // 6. Frost slowly returns in non-wet, non-wiped areas
    clear -= uRefrostRate * (1.0 - water);

    // 7. Manual refrost impulse
    clear -= uRefrostImpulse * 0.1;

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

class ClarityController {
    private canvas: HTMLCanvasElement;
    private props: Partial<ClarityProps>;

    private renderer: THREE.WebGLRenderer;
    private clock: THREE.Clock;
    private camera: THREE.OrthographicCamera;
    
    private mainScene: THREE.Scene;
    private mainMaterial: THREE.ShaderMaterial;
    
    private copyScene: THREE.Scene;
    private copyMaterial: THREE.ShaderMaterial;

    private physicsScene: THREE.Scene;
    private physicsMaterial: THREE.ShaderMaterial;

    private blurScene: THREE.Scene;
    private blurMaterial: THREE.ShaderMaterial;

    private physicsRenderTargetA: THREE.WebGLRenderTarget;
    private physicsRenderTargetB: THREE.WebGLRenderTarget;
    private sceneRenderTarget: THREE.WebGLRenderTarget;
    private blurRenderTargetA: THREE.WebGLRenderTarget;
    private blurRenderTargetB: THREE.WebGLRenderTarget;

    private mousePosition = new THREE.Vector2(-1000, -1000);
    private smoothedMouse = new THREE.Vector2(-1000, -1000);
    private isMouseActive = false;
    private refrostImpulse = 0.0;

    private mediaState = { type: '', src: '', loading: false };
    private videoElement: HTMLVideoElement | null = null;
    private objectURLs = new Set<string>();
    
    private isCancelled = false;
    private animationFrameId: number | null = null;
    private static DOWNSAMPLE_FACTOR = 2;
    private isReady = false;

    constructor(canvas: HTMLCanvasElement, initialProps: Partial<ClarityProps>) {
        this.canvas = canvas;
        this.props = initialProps;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        
        this.clock = new THREE.Clock();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const geometry = new THREE.PlaneGeometry(2, 2);

        this.mainMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uResolution: { value: new THREE.Vector2() }, uSceneTexture: { value: null }, uPhysicsState: { value: null }, uBlurredMap: { value: null }, uMouse: { value: new THREE.Vector2() }, uBrushSize: { value: 120.0 } } });
        this.mainScene = new THREE.Scene();
        this.mainScene.add(new THREE.Mesh(geometry, this.mainMaterial));

        this.copyMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: copyFragmentShader, uniforms: { uTexture: { value: null }, uResolution: { value: new THREE.Vector2() }, uImageResolution: { value: new THREE.Vector2() } } });
        this.copyScene = new THREE.Scene();
        this.copyScene.add(new THREE.Mesh(geometry, this.copyMaterial));
        
        this.physicsMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: physicsFragmentShader, uniforms: { uPreviousFrame: { value: null }, uResolution: { value: new THREE.Vector2() }, uMouse: { value: new THREE.Vector2() }, uBrushSize: { value: 120.0 }, uRefrostRate: { value: 0.0004 }, uIsMouseActive: { value: 0.0 }, uRefrostImpulse: { value: 0.0 } } });
        this.physicsScene = new THREE.Scene();
        this.physicsScene.add(new THREE.Mesh(geometry, this.physicsMaterial));
        
        this.blurMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: blurFragmentShader, uniforms: { uInput: { value: null }, uResolution: { value: new THREE.Vector2() }, uDirection: { value: new THREE.Vector2() } } });
        this.blurScene = new THREE.Scene();
        this.blurScene.add(new THREE.Mesh(geometry, this.blurMaterial));

        const renderTargetOptions = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType, stencilBuffer: false };
        this.physicsRenderTargetA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.physicsRenderTargetB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.sceneRenderTarget = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.blurRenderTargetA = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        this.blurRenderTargetB = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
        
        this.start();
    }
    
    public setProps(newProps: Partial<ClarityProps>) { this.props = newProps; }
    public triggerRefrost() { this.refrostImpulse = 1.0; }
    public updatePointer(x: number, y: number, isActive: boolean) {
        this.isMouseActive = isActive;
        if (isActive) { this.mousePosition.set(x, y); }
    }
    public resize = () => {
        const { brushSize, width: propWidth, height: propHeight } = this.props;
        const parent = this.canvas.parentElement;
        const w = propWidth ?? parent?.clientWidth ?? 0;
        const h = propHeight ?? parent?.clientHeight ?? 0;

        if (w <= 0 || h <= 0) {
            if (this.isReady) {
                console.log('Clarity: Canvas size is zero, pausing render.');
            }
            this.isReady = false;
            return;
        }

        if (!this.isReady) {
            console.log(`Clarity: Canvas resized to ${w}x${h}, starting render.`);
        }
        this.isReady = true;

        this.renderer.setSize(w, h, false);
        this.camera.updateProjectionMatrix();

        const downsampledWidth = Math.max(1, Math.round(w / ClarityController.DOWNSAMPLE_FACTOR));
        const downsampledHeight = Math.max(1, Math.round(h / ClarityController.DOWNSAMPLE_FACTOR));
        const brushPixelSize = Math.min(w, h) * (brushSize ?? 0.15);
        
        this.mainMaterial.uniforms.uResolution.value.set(w, h);
        this.mainMaterial.uniforms.uBrushSize.value = brushPixelSize;
        this.copyMaterial.uniforms.uResolution.value.set(w, h);
        this.physicsMaterial.uniforms.uResolution.value.set(w, h);
        this.physicsMaterial.uniforms.uBrushSize.value = brushPixelSize;
        this.blurMaterial.uniforms.uResolution.value.set(downsampledWidth, downsampledHeight);
        
        this.physicsRenderTargetA.setSize(w, h);
        this.physicsRenderTargetB.setSize(w, h);
        this.sceneRenderTarget.setSize(w, h);
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
        this.objectURLs.forEach(url => URL.revokeObjectURL(url));
        this.objectURLs.clear();
    }
    
    private async _loadImageTexture(imageUrl: string): Promise<{ texture: THREE.Texture, resolution: THREE.Vector2 }> {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        const blob = await response.blob();
        const objectURL = URL.createObjectURL(blob);
        this.objectURLs.add(objectURL);

        const loader = new THREE.TextureLoader();
        const texture = await loader.loadAsync(objectURL);

        if (this.isCancelled) {
            texture.dispose();
            throw new Error('Component unmounted during texture load');
        }
        
        const resolution = new THREE.Vector2(texture.image.width, texture.image.height);
        return { texture, resolution };
    }
    
    private async _loadVideoTexture(videoUrl: string): Promise<{ texture: THREE.VideoTexture, resolution: THREE.Vector2 }> {
        const response = await fetch(videoUrl);
        if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`);
        const blob = await response.blob();
        const objectURL = URL.createObjectURL(blob);
        this.objectURLs.add(objectURL);

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
                reject(new Error(`Failed to load video. Error: ${e.toString()}`));
            };

            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onError);

            video.src = objectURL;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.load();
        });
    }

    public async loadMedia() {
        const { mediaType, imageUrl, videoUrl } = this.props;
        const type = mediaType ?? 'image';
        const src = type === 'image' ? imageUrl : videoUrl;
        
        if (!src || this.mediaState.loading || (this.mediaState.type === type && this.mediaState.src === src)) {
            return;
        }

        this.mediaState = { loading: true, type, src };
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
            
            if (this.isCancelled) {
                 result.texture.dispose();
                 return;
            }

            result.texture.colorSpace = THREE.SRGBColorSpace;
            this.copyMaterial.uniforms.uTexture.value = result.texture;
            this.copyMaterial.uniforms.uImageResolution.value.copy(result.resolution);
            
            this.resize();
        } catch (error) {
            let errorMessage = "An unknown error occurred while loading media.";
            if (error instanceof Error) {
                if (error.message.includes("Failed to fetch")) {
                    errorMessage = `Network Error: Could not fetch media. This is often a CORS policy issue on the server hosting the media. Please ensure the asset is publicly accessible. URL: ${src}`;
                } else {
                    errorMessage = error.message;
                }
            } else {
                errorMessage = String(error);
            }
            
            console.error(`Clarity Component Error: ${errorMessage}`);
            
            if (!this.isCancelled) {
                this.props.onError?.(errorMessage);
            }
            this._cleanupPreviousMedia();
        } finally {
            if (!this.isCancelled) {
                this.mediaState.loading = false;
            }
        }
    }

    private _animate = () => {
        if (this.isCancelled) return;
        this.animationFrameId = requestAnimationFrame(this._animate);

        if (!this.isReady) {
            return;
        }

        const { refrostRate } = this.props;
        this.physicsMaterial.uniforms.uRefrostRate.value = refrostRate ?? 0.0004;

        this.smoothedMouse.lerp(this.mousePosition, 0.1);
        this.refrostImpulse = THREE.MathUtils.lerp(this.refrostImpulse, 0.0, 0.1);
        
        this.renderer.setRenderTarget(this.physicsRenderTargetB);
        this.physicsMaterial.uniforms.uPreviousFrame.value = this.physicsRenderTargetA.texture;
        this.physicsMaterial.uniforms.uMouse.value.copy(this.smoothedMouse);
        this.physicsMaterial.uniforms.uIsMouseActive.value = this.isMouseActive ? 1.0 : 0.0;
        this.physicsMaterial.uniforms.uRefrostImpulse.value = this.refrostImpulse;
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

        this.renderer.dispose();
        this.mainScene.traverse(obj => { if (obj instanceof THREE.Mesh) obj.geometry.dispose(); });
        this.mainMaterial.dispose();
        this.copyMaterial.dispose();
        this.physicsMaterial.dispose();
        this.blurMaterial.dispose();
        this.physicsRenderTargetA.dispose();
        this.physicsRenderTargetB.dispose();
        this.sceneRenderTarget.dispose();
        this.blurRenderTargetA.dispose();
        this.blurRenderTargetB.dispose();
    }
}


export default function Clarity(props: Partial<ClarityProps>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<ClarityController | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    
    const controller = new ClarityController(canvas, { ...props, onError: setError });
    controllerRef.current = controller;

    const resizeObserver = new ResizeObserver(() => {
        controller.resize();
    });
    resizeObserver.observe(parent);
    
    controller.resize();
    
    return () => {
      resizeObserver.disconnect();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    controller.setProps({ ...props, onError: setError });
    controller.resize();
  }, [props]);

  useEffect(() => {
    setError(null);
    controllerRef.current?.loadMedia();
  }, [props.mediaType, props.imageUrl, props.videoUrl]);

  usePointerEvents(
    canvasRef,
    useCallback((x: number, y: number, isActive: boolean) => {
      controllerRef.current?.updatePointer(x, y, isActive);
    }, [])
  );

  useEffect(() => {
    if (props.refrostTrigger !== undefined && props.refrostTrigger > 0) {
      controllerRef.current?.triggerRefrost();
    }
  }, [props.refrostTrigger]);

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

//@ts-ignore
Clarity.defaultProps = {
    mediaType: 'image',
    imageUrl: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=2070&auto=format&fit=crop",
    refrostRate: 0.0004,
    brushSize: 0.15,
    refrostTrigger: 0,
} 

addPropertyControls(Clarity, {
    mediaType: { type: ControlType.Enum, title: "Media", options: ['image', 'video'], defaultValue: 'image' },
    imageUrl: { type: ControlType.Image, title: "Image", hidden: (props) => props.mediaType !== 'image' },
    videoUrl: { type: ControlType.File, title: "Video", allowedFileTypes: ['mp4', 'webm', 'mov'], hidden: (props) => props.mediaType !== 'video' },
    refrostRate: { type: ControlType.Number, title: "Refrost Rate", min: 0, max: 0.005, step: 0.0001, defaultValue: 0.0004, displayStepper: true },
    brushSize: { type: ControlType.Number, title: "Pointer Size", min: 0.05, max: 0.5, step: 0.01, defaultValue: 0.15, displayStepper: true },
});