//main.tsx
import React, { useRef, useEffect, useMemo, useState } from 'react';
import { addPropertyControls, ControlType } from 'framer';
import html2canvas from 'html2canvas';
import { useFluidSimulation } from './engine.tsx';

// --- MERGED FROM presets.tsx ---

// --- TYPES ---
export interface Uniforms {
    uArtisticBlend: number;
    uDisplacementScale: number;
    uVelocityShiftScale: number;
    uDensityShiftScale: number;
    uWaterColor: string;
    uInkColor: string;
    uVolumeFactor: number;
    uInkStrength: number;
    uShininess: number;
    uFresnelColor: string;
    uFresnelIntensity: number;
    uGlowColor: string;
    uGlowPower: number;
    uInkGeneration: number;
    uWaveSize: number;
    uWaveSteepness: number;
    uWaveComplexity: number;
    uWaveDetail: number;
    uFeedRate: number;
    uKillRate: number;
    uVorticity: number;
    uReactionForce: number;
    uBuoyancy: number;
    uAmbientTemperature: number;
    uSplatTemperature: number;
    uBorderThickness: number;
    uBorderColor: string;
    uSurfaceTension: number;
    uChiselStrength: number;
    uSSR_Strength: number;
    uSSR_Falloff: number;
    uSSR_Samples: number;
    uParticleRate: number;
    uParticleSize: number;
    uParticleAdvection: number;
    uParticleColor: string;
    uCausticsIntensity: number;
    uLightDepth: number;
    uSurfaceDetailStrength: number;
    uFlowSpeed: number;
    uRippleStrength: number;
    uRippleDamping: number;
    uRippleSpeed: number;
    uLight1Pos: { x: number; y: number; z: number };
    uLight1Color: string;
    uLight2Pos: { x: number; y: number; z: number };
    uLight2Color: string;
}

export interface SimParams {
    waveDecay: number;
    densityDissipation: number;
    temperatureDissipation: number;
}

export type AllParams = Uniforms & SimParams;

export interface Version {
    name: string;
    uniforms: Uniforms;
    simParams: SimParams;
}

export interface QualitySettings {
    simResolution: number;
    particleResolution: number;
    enableSsr: boolean;
}

// --- PRESETS ---
export const sora: Version = {
    name: 'Sora',
    uniforms: {
        uArtisticBlend: 0,
        uDisplacementScale: 0.055,
        uVelocityShiftScale: 0.0006,
        uDensityShiftScale: 0.0042,
        uWaterColor: "#820792",
        uInkColor: "#641b5e",
        uVolumeFactor: 0.67,
        uInkStrength: 0.85,
        uShininess: 437,
        uFresnelColor: "#b706db",
        uFresnelIntensity: 3.2,
        uGlowColor: "#f42aaa",
        uGlowPower: 1.3,
        uInkGeneration: 0.05,
        uWaveSize: 0.157,
        uWaveSteepness: 0.119,
        uWaveComplexity: 0.014,
        uWaveDetail: 0.008,
        uFeedRate: 0.023,
        uKillRate: 0.028,
        uVorticity: 0.4,
        uReactionForce: 0.3,
        uBuoyancy: 2,
        uAmbientTemperature: 0.28,
        uSplatTemperature: 0,
        uBorderThickness: 0,
        uBorderColor: "#fffafa",
        uSurfaceTension: 0.84,
        uChiselStrength: 3.89,
        uSSR_Strength: 0.03,
        uSSR_Falloff: 4.3,
        uSSR_Samples: 2,
        uParticleRate: 0,
        uParticleSize: 2,
        uParticleAdvection: 0.2,
        uParticleColor: "#ffffff",
        uCausticsIntensity: 1.2,
        uLightDepth: 0.5,
        uSurfaceDetailStrength: 0,
        uFlowSpeed: 0,
        uRippleStrength: 0,
        uRippleDamping: 0.98,
        uRippleSpeed: 0.7,
        uLight1Pos: { x: 0.8, y: 0.2, z: 0.7 },
        uLight1Color: "#eef2ff",
        uLight2Pos: { x: 0.2, y: 0.8, z: 0.3 },
        uLight2Color: "#b1b1c3",
    },
    simParams: {
        waveDecay: 0.976,
        densityDissipation: 0.88,
        temperatureDissipation: 0.885
    }
};

export const versions: Version[] = [
    sora
];

const defaultPreset = sora;

// --- UTILITIES ---
const debounce = (func: (...args: any[]) => void, delay: number) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (...args: any[]) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => func(...args), delay);
    };
};

const convertPropsToEngineParams = (props: any): AllParams => {
    const {
        material, physics, waveShape, ripples, surfaceDetail,
        reflections, caustics, particles, engine, fading,
        colors, lighting
    } = props;

    return {
        ...material, ...physics, ...waveShape, ...ripples,
        ...surfaceDetail, ...reflections, ...caustics,
        ...particles, ...engine, ...fading, ...colors,
        uLight1Color: lighting.uLight1Color,
        uLight1Pos: lighting.uLight1Pos,
        uLight2Color: lighting.uLight2Color,
        uLight2Pos: lighting.uLight2Pos,
    };
};

// --- TEXTURE GENERATION ---
export const createTextCanvas = (
    width: number,
    height: number,
    text: string,
    backgroundColor: string,
    textColor: string
): HTMLCanvasElement => {
    const textCanvas = document.createElement('canvas');
    textCanvas.width = width;
    textCanvas.height = height;
    const ctx = textCanvas.getContext('2d');
    if (ctx) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, width, height);
        if (text) {
            ctx.fillStyle = textColor;
            const fontSize = Math.min(width, height) * 0.15;
            ctx.font = `900 ${fontSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, width / 2, height / 2);
        }
    }
    return textCanvas;
};

// --- SIMULATION CORE COMPONENT ---
// This component is now "dumb" and simply renders the simulation based on the props it receives.
function FluidSimulationCore(props: any) {
    const { width, height, textureLayer, defaultTexture, quality, simParams } = props;

    const mountRef = useRef<HTMLDivElement>(null);
    const textureWrapperRef = useRef<HTMLDivElement>(null);
    const [textureCanvas, setTextureCanvas] = useState<HTMLCanvasElement | null>(null);

    useEffect(() => {
        let alive = true;
        const container = mountRef.current;
        if (!container) return;

        const generateTexture = async () => {
            if (!alive || !mountRef.current) return;
            const { clientWidth, clientHeight } = mountRef.current;
            if (clientWidth === 0 || clientHeight === 0) return;

            let canvas: HTMLCanvasElement | null = null;
            const targetElement = textureWrapperRef.current?.firstElementChild as HTMLElement | null;

            if (textureLayer && targetElement) {
                await new Promise(resolve => setTimeout(resolve, 50));
                if (!alive) return;
                try {
                    canvas = await html2canvas(targetElement, {
                        backgroundColor: null,
                        width: clientWidth,
                        height: clientHeight,
                        logging: false,
                    });
                } catch (error) {
                    console.error("html2canvas failed:", error);
                    canvas = createTextCanvas(clientWidth, clientHeight, defaultTexture.text, defaultTexture.backgroundColor, defaultTexture.textColor);
                }
            } else {
                canvas = createTextCanvas(clientWidth, clientHeight, defaultTexture.text, defaultTexture.backgroundColor, defaultTexture.textColor);
            }

            if (alive && canvas) {
                setTextureCanvas(canvas);
            }
        };

        const debouncedGenerateTexture = debounce(generateTexture, 250);
        debouncedGenerateTexture();

        const resizeObserver = new ResizeObserver(() => debouncedGenerateTexture());
        resizeObserver.observe(container);

        let mutationObserver: MutationObserver | null = null;
        if (textureLayer && textureWrapperRef.current) {
            mutationObserver = new MutationObserver(() => debouncedGenerateTexture());
            mutationObserver.observe(textureWrapperRef.current, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });
        }

        return () => {
            alive = false;
            resizeObserver.disconnect();
            if (mutationObserver) mutationObserver.disconnect();
        };
    }, [textureLayer, defaultTexture]);

    const fullQuality = useMemo(() => {
        const preset = versions.find(v => v.name === props.preset) || defaultPreset;
        const presetHasSsr = preset.uniforms.uSSR_Strength > 0 && preset.uniforms.uSSR_Samples > 0;
        return {
            simResolution: quality.simResolution,
            particleResolution: quality.particleResolution,
            enableSsr: props.quality.enableSsr === undefined ? presetHasSsr : props.quality.enableSsr,
        }
    }, [props.preset, quality]);
    
    useFluidSimulation(mountRef, simParams, fullQuality, textureCanvas);

    return (
        <>
            <div 
                ref={mountRef} 
                style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }} 
                aria-hidden="true" 
            />
            <div style={{ position: "fixed", top: 0, left: "-9999px", zIndex: -1, width: width, height: height }}>
                <div ref={textureWrapperRef}>{textureLayer}</div>
            </div>
        </>
    );
};


// --- WRAPPER COMPONENT FOR FRAMER ---
/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 */
export default function FluidSimulationWrapper(props: any) {
    const { preset: presetName } = props;

    // Ref to store the previous preset name to detect changes.
    const prevPresetRef = useRef(presetName);

    // This is the master state for the simulation parameters.
    const [simParams, setSimParams] = useState(() => {
        const presetData = versions.find(v => v.name === presetName) || defaultPreset;
        return { ...presetData.uniforms, ...presetData.simParams };
    });

    // This effect is the core of the solution. It synchronizes the internal
    // state with incoming props from Framer, handling both preset changes and overrides.
    useEffect(() => {
        const newPresetName = props.preset;
        const oldPresetName = prevPresetRef.current;

        if (newPresetName !== oldPresetName) {
            // A. PRESET CHANGE DETECTED:
            // Reset the state entirely to the new preset's canonical values.
            // This discards all stale overrides from the previous preset.
            const presetData = versions.find(v => v.name === newPresetName) || defaultPreset;
            setSimParams({ ...presetData.uniforms, ...presetData.simParams });
            prevPresetRef.current = newPresetName;
        } else {
            // B. NO PRESET CHANGE - THIS IS A MANUAL OVERRIDE:
            // Update the state from the current props, applying the user's change.
            setSimParams(convertPropsToEngineParams(props));
        }
    }, [props]); // The effect runs whenever any prop from Framer changes.

    // The core simulation component is now "dumb" and just receives the
    // correctly managed state from this wrapper.
    return <FluidSimulationCore {...props} simParams={simParams} />;
}


// --- FRAMER PROPERTY CONTROLS ---
addPropertyControls(FluidSimulationWrapper, {
    textureLayer: {
        type: ControlType.ComponentInstance,
        title: "Custom Texture",
    },
    defaultTexture: {
        type: ControlType.Object,
        title: "Default Texture",
        controls: {
            text: { type: ControlType.String, title: "Text", defaultValue: "PLAY" },
            backgroundColor: { type: ControlType.Color, title: "BG Color", defaultValue: "#000000" },
            textColor: { type: ControlType.Color, title: "Text Color", defaultValue: "#FFFFFF" },
        },
        hidden: (props) => !!props.textureLayer,
    },
    quality: {
        type: ControlType.Object,
        title: "Quality",
        controls: {
            simResolution: { type: ControlType.Enum, title: "Resolution", options: [128, 256, 512], defaultValue: 256 },
            particleResolution: { type: ControlType.Enum, title: "Particles", options: [0, 128, 256, 512], optionTitles: ["Off", "Low", "Medium", "High"], defaultValue: 256 },
            enableSsr: { type: ControlType.Boolean, title: "Reflections", defaultValue: true },
        },
    },
    material: {
        type: ControlType.Object, title: "Material",
        controls: {
            uArtisticBlend: { type: ControlType.Number, title: "Artistic Blend", min: 0, max: 1, step: 0.01, defaultValue: defaultPreset.uniforms.uArtisticBlend },
            uDisplacementScale: { type: ControlType.Number, title: "Refraction", min: 0, max: 0.2, step: 0.001, defaultValue: defaultPreset.uniforms.uDisplacementScale },
            uVelocityShiftScale: { type: ControlType.Number, title: "Velocity RGB Shift", min: 0, max: 0.05, step: 0.0001, defaultValue: defaultPreset.uniforms.uVelocityShiftScale },
            uDensityShiftScale: { type: ControlType.Number, title: "Density RGB Shift", min: 0, max: 0.1, step: 0.0001, defaultValue: defaultPreset.uniforms.uDensityShiftScale },
            uVolumeFactor: { type: ControlType.Number, title: "Volume", min: 0, max: 1, step: 0.01, defaultValue: defaultPreset.uniforms.uVolumeFactor },
            uInkStrength: { type: ControlType.Number, title: "Ink Strength", min: 0, max: 5, step: 0.05, defaultValue: defaultPreset.uniforms.uInkStrength },
            uShininess: { type: ControlType.Number, title: "Shininess", min: 1, max: 1024, step: 1, defaultValue: defaultPreset.uniforms.uShininess },
            uFresnelIntensity: { type: ControlType.Number, title: "Fresnel Intensity", min: 0, max: 5, step: 0.1, defaultValue: defaultPreset.uniforms.uFresnelIntensity },
            uGlowPower: { type: ControlType.Number, title: "Glow Power", min: 0, max: 10, step: 0.1, defaultValue: defaultPreset.uniforms.uGlowPower },
        }
    },
    physics: {
        type: ControlType.Object, title: "Physics",
        controls: {
            uSurfaceTension: { type: ControlType.Number, title: "Surface Tension", min: 0, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uSurfaceTension },
            uBuoyancy: { type: ControlType.Number, title: "Buoyancy Force", min: 0, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uBuoyancy },
            uSplatTemperature: { type: ControlType.Number, title: "Splat Temperature", min: -1, max: 1, step: 0.01, defaultValue: defaultPreset.uniforms.uSplatTemperature },
            uAmbientTemperature: { type: ControlType.Number, title: "Ambient Temp", min: 0, max: 1, step: 0.01, defaultValue: defaultPreset.uniforms.uAmbientTemperature },
            uVorticity: { type: ControlType.Number, title: "Vorticity", min: 0, max: 50, step: 0.1, defaultValue: defaultPreset.uniforms.uVorticity },
            uReactionForce: { type: ControlType.Number, title: "Reaction Force", min: 0, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uReactionForce },
            uFeedRate: { type: ControlType.Number, title: "Feed Rate", min: 0, max: 0.1, step: 0.001, defaultValue: defaultPreset.uniforms.uFeedRate },
            uKillRate: { type: ControlType.Number, title: "Kill Rate", min: 0, max: 0.1, step: 0.001, defaultValue: defaultPreset.uniforms.uKillRate },
        }
    },
    waveShape: {
        type: ControlType.Object, title: "Wave Shape",
        controls: {
            uChiselStrength: { type: ControlType.Number, title: "Chisel Strength", min: 0, max: 5, step: 0.01, defaultValue: defaultPreset.uniforms.uChiselStrength },
            uWaveSize: { type: ControlType.Number, title: "Wave Size", min: 0.01, max: 0.3, step: 0.001, defaultValue: defaultPreset.uniforms.uWaveSize },
            uWaveSteepness: { type: ControlType.Number, title: "Steepness", min: 0.01, max: 0.2, step: 0.001, defaultValue: defaultPreset.uniforms.uWaveSteepness },
            uWaveComplexity: { type: ControlType.Number, title: "Complexity", min: 0, max: 0.5, step: 0.001, defaultValue: defaultPreset.uniforms.uWaveComplexity },
            uWaveDetail: { type: ControlType.Number, title: "Detail", min: 0, max: 0.1, step: 0.001, defaultValue: defaultPreset.uniforms.uWaveDetail },
            uBorderThickness: { type: ControlType.Number, title: "Border Thickness", min: 0, max: 0.5, step: 0.001, defaultValue: defaultPreset.uniforms.uBorderThickness },
        }
    },
    ripples: {
        type: ControlType.Object, title: "Ripples",
        controls: {
            uRippleStrength: { type: ControlType.Number, title: "Strength", min: 0, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uRippleStrength },
            uRippleSpeed: { type: ControlType.Number, title: "Speed", min: 0, max: 1.5, step: 0.01, defaultValue: defaultPreset.uniforms.uRippleSpeed },
            uRippleDamping: { type: ControlType.Number, title: "Damping", min: 0.9, max: 1, step: 0.001, defaultValue: defaultPreset.uniforms.uRippleDamping },
        }
    },
    surfaceDetail: {
        type: ControlType.Object, title: "Surface Detail",
        controls: {
            uSurfaceDetailStrength: { type: ControlType.Number, title: "Strength", min: 0, max: 1, step: 0.01, defaultValue: defaultPreset.uniforms.uSurfaceDetailStrength },
            uFlowSpeed: { type: ControlType.Number, title: "Flow Speed", min: 0, max: 10, step: 0.01, defaultValue: defaultPreset.uniforms.uFlowSpeed },
        }
    },
    reflections: {
        type: ControlType.Object, title: "Reflections",
        controls: {
            uSSR_Strength: { type: ControlType.Number, title: "Strength", min: 0, max: 3, step: 0.01, defaultValue: defaultPreset.uniforms.uSSR_Strength },
            uSSR_Falloff: { type: ControlType.Number, title: "Falloff", min: 0, max: 5, step: 0.1, defaultValue: defaultPreset.uniforms.uSSR_Falloff },
            uSSR_Samples: { type: ControlType.Number, title: "Samples", min: 0, max: 30, step: 1, defaultValue: defaultPreset.uniforms.uSSR_Samples },
        }
    },
    caustics: {
        type: ControlType.Object, title: "Caustics",
        controls: {
            uCausticsIntensity: { type: ControlType.Number, title: "Intensity", min: 0, max: 5, step: 0.1, defaultValue: defaultPreset.uniforms.uCausticsIntensity },
        }
    },
    particles: {
        type: ControlType.Object, title: "Particles",
        controls: {
            uParticleRate: { type: ControlType.Number, title: "Rate", min: 0, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uParticleRate },
            uParticleSize: { type: ControlType.Number, title: "Size", min: 0, max: 10, step: 0.1, defaultValue: defaultPreset.uniforms.uParticleSize },
            uParticleAdvection: { type: ControlType.Number, title: "Flow", min: 0, max: 1, step: 0.01, defaultValue: defaultPreset.uniforms.uParticleAdvection },
        }
    },
    engine: {
        type: ControlType.Object, title: "Engine",
        controls: {
            waveDecay: { type: ControlType.Number, title: "Wave Decay", min: 0.8, max: 1, step: 0.001, defaultValue: defaultPreset.simParams.waveDecay },
        }
    },
    fading: {
        type: ControlType.Object, title: "Fading",
        controls: {
            densityDissipation: { type: ControlType.Number, title: "Density", min: 0.8, max: 1, step: 0.001, defaultValue: defaultPreset.simParams.densityDissipation },
            temperatureDissipation: { type: ControlType.Number, title: "Temperature", min: 0.8, max: 1, step: 0.001, defaultValue: defaultPreset.simParams.temperatureDissipation },
        }
    },
    colors: {
        type: ControlType.Object, title: "Colors",
        controls: {
            uWaterColor: { type: ControlType.Color, title: "Water", defaultValue: defaultPreset.uniforms.uWaterColor },
            uInkColor: { type: ControlType.Color, title: "Ink", defaultValue: defaultPreset.uniforms.uInkColor },
            uFresnelColor: { type: ControlType.Color, title: "Fresnel", defaultValue: defaultPreset.uniforms.uFresnelColor },
            uGlowColor: { type: ControlType.Color, title: "Glow", defaultValue: defaultPreset.uniforms.uGlowColor },
            uBorderColor: { type: ControlType.Color, title: "Border", defaultValue: defaultPreset.uniforms.uBorderColor },
            uParticleColor: { type: ControlType.Color, title: "Particle", defaultValue: defaultPreset.uniforms.uParticleColor },
        }
    },
    lighting: {
        type: ControlType.Object, title: "Lighting",
        controls: {
            uLight1Color: { type: ControlType.Color, title: "Light 1 Color", defaultValue: defaultPreset.uniforms.uLight1Color },
            uLight1Pos: {
                type: ControlType.Object, title: "Light 1 Pos",
                controls: {
                    x: { type: ControlType.Number, title: "X", min: -2, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uLight1Pos.x },
                    y: { type: ControlType.Number, title: "Y", min: -2, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uLight1Pos.y },
                    z: { type: ControlType.Number, title: "Z", min: 0.1, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uLight1Pos.z },
                },
            },
            uLight2Color: { type: ControlType.Color, title: "Light 2 Color", defaultValue: defaultPreset.uniforms.uLight2Color },
            uLight2Pos: {
                type: ControlType.Object, title: "Light 2 Pos",
                controls: {
                    x: { type: ControlType.Number, title: "X", min: -2, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uLight2Pos.x },
                    y: { type: ControlType.Number, title: "Y", min: -2, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uLight2Pos.y },
                    z: { type: ControlType.Number, title: "Z", min: 0.1, max: 2, step: 0.01, defaultValue: defaultPreset.uniforms.uLight2Pos.z },
                },
            },
        }
    },
});