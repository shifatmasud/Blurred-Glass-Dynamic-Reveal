//engine.tsx
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AllParams, QualitySettings } from './main.tsx';

// --- CONSTANTS ---
const PRESSURE_ITERATIONS = 20;
const REACTION_DIFFUSION_ITERATIONS = 10;

// --- SHADERS ---
// Note: Shaders from Flat.tsx were converted from GLSL 3.0 to 1.0 for compatibility with THREE.ShaderMaterial
// (e.g., 'in' -> 'varying', 'texture' -> 'texture2D', removed 'out' and 'precision')
export const shaders = {
baseVertexShader: `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`,

splatShader: `
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float uAspectRatio;
  uniform vec3 uColor;
  uniform vec2 uCenter;
  uniform float uRadius;

  void main() {
    vec2 p = vUv - uCenter.xy;
    p.x *= uAspectRatio;
    float intensity = 1.0 - smoothstep(0.0, uRadius, length(p));
    vec3 splat = uColor * intensity;
    vec3 base = texture2D(uTarget, vUv).rgb;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`,

advectionShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 uTexelSize;
    uniform float uDt;
    uniform float uDissipation;

    void main() {
        vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexelSize;
        gl_FragColor = uDissipation * texture2D(uSource, coord);
    }
`,

divergenceShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform vec2 uTexelSize;

    void main () {
        float L = texture2D(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).x;
        float R = texture2D(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).x;
        float B = texture2D(uVelocity, vUv - vec2(0.0, uTexelSize.y)).y;
        float T = texture2D(uVelocity, vUv + vec2(0.0, uTexelSize.y)).y;
        
        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`,

clearShader: `
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float uValue;
    uniform vec3 uClearColor;
    uniform bool uUseClearColor;

    void main () {
        if (uUseClearColor) {
            gl_FragColor = vec4(uClearColor, 1.0);
        } else {
            gl_FragColor = uValue * texture2D(uTexture, vUv);
        }
    }
`,

pressureShader: `
    varying vec2 vUv;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    uniform vec2 uTexelSize;

    void main () {
        float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
        float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
        float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
        float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`,

gradientSubtractShader: `
    varying vec2 vUv;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    uniform vec2 uTexelSize;

    void main () {
        float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
        float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
        float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
        float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= 0.5 * vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`,

reactionDiffusionShader: `
    varying vec2 vUv;
    uniform sampler2D uChemicals;
    uniform vec2 uTexelSize;
    uniform float uFeedRate;
    uniform float uKillRate;
    
    const float uDu = 0.16;
    const float uDv = 0.08;
    const float uDt = 1.0;

    void main() {
        if (uFeedRate < 0.001 && uKillRate < 0.001) {
            gl_FragColor = texture2D(uChemicals, vUv);
            return;
        }

        vec2 chemical = texture2D(uChemicals, vUv).rg;
        float u = chemical.r;
        float v = chemical.g;

        float lap_u = (
            texture2D(uChemicals, vUv + vec2(0.0, uTexelSize.y)).r +
            texture2D(uChemicals, vUv - vec2(0.0, uTexelSize.y)).r +
            texture2D(uChemicals, vUv + vec2(uTexelSize.x, 0.0)).r +
            texture2D(uChemicals, vUv - vec2(uTexelSize.x, 0.0)).r -
            4.0 * u
        );

        float lap_v = (
            texture2D(uChemicals, vUv + vec2(0.0, uTexelSize.y)).g +
            texture2D(uChemicals, vUv - vec2(0.0, uTexelSize.y)).g +
            texture2D(uChemicals, vUv + vec2(uTexelSize.x, 0.0)).g +
            texture2D(uChemicals, vUv - vec2(uTexelSize.x, 0.0)).g -
            4.0 * v
        );

        float reaction = u * v * v;
        float du_dt = uDu * lap_u - reaction + uFeedRate * (1.0 - u);
        float dv_dt = uDv * lap_v + reaction - (uKillRate + uFeedRate) * v;

        float new_u = u + du_dt * uDt;
        float new_v = v + dv_dt * uDt;

        float old_b = texture2D(uChemicals, vUv).b;
        gl_FragColor = vec4(clamp(new_u, 0.0, 1.0), clamp(new_v, 0.0, 1.0), old_b, 1.0);
    }
`,

curlShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform vec2 uTexelSize;

    void main() {
        float L = texture2D(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
        float R = texture2D(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
        float B = texture2D(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
        float T = texture2D(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;
        
        float curl = 0.5 * ((T - B) - (R - L));
        gl_FragColor = vec4(curl, 0.0, 0.0, 1.0);
    }
`,

vorticityShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float uVorticity;
    uniform float uDt;
    uniform vec2 uTexelSize;

    void main() {
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        if (uVorticity < 0.01) {
            gl_FragColor = vec4(velocity, 0.0, 1.0);
            return;
        }

        float L = texture2D(uCurl, vUv - vec2(uTexelSize.x, 0.0)).r;
        float R = texture2D(uCurl, vUv + vec2(uTexelSize.x, 0.0)).r;
        float B = texture2D(uCurl, vUv - vec2(0.0, uTexelSize.y)).r;
        float T = texture2D(uCurl, vUv + vec2(0.0, uTexelSize.y)).r;
        
        float curl = texture2D(uCurl, vUv).r;
        
        vec2 grad = 0.5 * vec2(R - L, T - B);
        vec2 N = normalize(grad + 0.0001);
        vec2 force = uVorticity * curl * vec2(N.y, -N.x);
        
        velocity += force * uDt;
        
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`,

surfaceTensionShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uDensity;
    uniform float uSurfaceTension;
    uniform float uDt;
    uniform vec2 uTexelSize;

    void main() {
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        if (uSurfaceTension < 0.001) {
            gl_FragColor = vec4(velocity, 0.0, 1.0);
            return;
        }
        
        float density = texture2D(uDensity, vUv).g;
        if (density < 0.01) {
            gl_FragColor = vec4(velocity, 0.0, 1.0);
            return;
        }

        float L = texture2D(uDensity, vUv - vec2(uTexelSize.x, 0.0)).g;
        float R = texture2D(uDensity, vUv + vec2(uTexelSize.x, 0.0)).g;
        float B = texture2D(uDensity, vUv - vec2(0.0, uTexelSize.y)).g;
        float T = texture2D(uDensity, vUv + vec2(0.0, uTexelSize.y)).g;
        
        vec2 grad = 0.5 * vec2(R - L, T - B);
        
        float laplacian = (L + R + B + T) - 4.0 * density;

        vec2 force = -uSurfaceTension * laplacian * normalize(grad + 0.0001) * 2.0;
        
        velocity += force * uDt;
        
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`,

reactionForceShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uChemicals;
    uniform float uReactionForce;
    uniform vec2 uTexelSize;

    void main() {
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        if (uReactionForce < 0.001) {
            gl_FragColor = vec4(velocity, 0.0, 1.0);
            return;
        }

        float L = texture2D(uChemicals, vUv - vec2(uTexelSize.x, 0.0)).g;
        float R = texture2D(uChemicals, vUv + vec2(uTexelSize.x, 0.0)).g;
        float B = texture2D(uChemicals, vUv - vec2(0.0, uTexelSize.y)).g;
        float T = texture2D(uChemicals, vUv + vec2(0.0, uTexelSize.y)).g;
        
        vec2 gradV = 0.5 * vec2(R - L, T - B);
        
        gl_FragColor = vec4(velocity - gradV * uReactionForce, 0.0, 1.0);
    }
`,

buoyancyShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uTemperature;
    uniform float uBuoyancy;
    uniform float uAmbientTemperature;
    uniform float uDt;

    void main() {
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        if (uBuoyancy < 0.001) {
            gl_FragColor = vec4(velocity, 0.0, 1.0);
            return;
        }
        float temp = texture2D(uTemperature, vUv).r;
        float force = uBuoyancy * (temp - uAmbientTemperature);
        velocity.y += force * uDt;
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`,

eraseShader: `
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float uAspectRatio;
    uniform vec2 uCenter;
    uniform float uRadius;
    uniform float uStrength;

    void main() {
        vec2 p = vUv - uCenter.xy;
        p.x *= uAspectRatio;
        float intensity = 1.0 - smoothstep(0.0, uRadius, length(p));
        vec4 base = texture2D(uTarget, vUv);
        
        base.rg *= 1.0 - intensity * uStrength;
        
        gl_FragColor = base;
    }
`,

radialPushShader: `
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float uAspectRatio;
    uniform vec2 uCenter;
    uniform float uRadius;
    uniform float uStrength;

    void main() {
        vec2 p = vUv - uCenter.xy;
        p.x *= uAspectRatio;
        
        float falloff = 1.0 - smoothstep(0.0, uRadius, length(p));
        if (falloff <= 0.0) {
            gl_FragColor = texture2D(uTarget, vUv);
            return;
        }

        vec2 direction = normalize(p + 0.0001);
        vec2 pushForce = direction * falloff * uStrength;
        
        vec2 baseVelocity = texture2D(uTarget, vUv).xy;
        gl_FragColor = vec4(baseVelocity + pushForce, 0.0, 1.0);
    }
`,

particleSplatShader: `
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform vec2 uCenter;
    uniform float uRadius;
    uniform float uIntensity;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
        vec4 particle = texture2D(uTarget, vUv);

        if (particle.b >= particle.a) {
            vec2 p = vUv - uCenter;
            float falloff = 1.0 - smoothstep(0.0, uRadius, length(p));
            
            if (falloff > 0.0 && hash(vUv * 999.0) < uIntensity * falloff * 0.2) {
                float lifetime = 2.0 + hash(vUv.yx) * 3.0;
                gl_FragColor = vec4(uCenter.x, uCenter.y, 0.0, lifetime);
                return;
            }
        }
        
        gl_FragColor = particle;
    }
`,

particleUpdateShader: `
    varying vec2 vUv;
    uniform sampler2D uParticles;
    uniform sampler2D uVelocity;
    uniform float uDt;
    uniform float uParticleAdvection;

    void main() {
        vec4 particle = texture2D(uParticles, vUv);

        if (particle.b >= particle.a) {
            gl_FragColor = vec4(0.0, 0.0, particle.a, particle.a);
            return;
        }

        vec2 pos = particle.xy;
        vec2 vel = texture2D(uVelocity, pos).xy;

        pos += vel * uDt * uParticleAdvection;
        
        pos = mod(pos, 1.0);

        float age = particle.b + uDt;
        
        gl_FragColor = vec4(pos, age, particle.a);
    }
`,

particleRenderVS: `
    uniform sampler2D uParticles;
    uniform float uParticleSize;
    attribute vec2 a_uv;
    varying float v_age_ratio;

    void main() {
        vec4 particle = texture2D(uParticles, a_uv);
        v_age_ratio = particle.b / particle.a;

        if (particle.b < particle.a) {
            vec2 pos = (particle.xy * 2.0) - 1.0;
            gl_Position = vec4(pos, 0.0, 1.0);
            gl_PointSize = uParticleSize * (1.0 - v_age_ratio);
        } else {
            gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
            gl_PointSize = 0.0;
        }
    }
`,

particleRenderFS: `
    uniform vec3 uParticleColor;
    varying float v_age_ratio;

    void main() {
        if (v_age_ratio > 1.0) discard;
        float alpha = pow(1.0 - v_age_ratio, 2.0); 
        gl_FragColor = vec4(uParticleColor * alpha, 1.0);
    }
`,

causticsShader: `
    varying vec2 vUv;
    uniform sampler2D uDensityTexture;
    uniform vec2 uTexelSize;
    
    void main() {
        float h = texture2D(uDensityTexture, vUv).g;
        float h_l = texture2D(uDensityTexture, vUv - vec2(uTexelSize.x, 0.0)).g;
        float h_r = texture2D(uDensityTexture, vUv + vec2(uTexelSize.x, 0.0)).g;
        float h_b = texture2D(uDensityTexture, vUv - vec2(0.0, uTexelSize.y)).g;
        float h_t = texture2D(uDensityTexture, vUv + vec2(0.0, uTexelSize.y)).g;
        
        float laplacian = (h_l + h_r + h_b + h_t) - 4.0 * h;
        float caustics = clamp(1.0 - laplacian * 200.0, 0.0, 1.0);
        
        float density = texture2D(uDensityTexture, vUv).g;
        
        gl_FragColor = vec4(vec3(pow(caustics, 3.0) * density), 1.0);
    }
`,

flowMapShader: `
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uFlowMap;
    uniform float uFlowSpeed;
    uniform float uDt;

    void main() {
        vec2 velocity = texture2D(uVelocity, vUv).xy * 0.1;
        vec2 oldFlow = texture2D(uFlowMap, vUv).xy;
        vec2 newFlow = mix(oldFlow, velocity, uDt * uFlowSpeed);
        gl_FragColor = vec4(newFlow, 0.0, 1.0);
    }
`,

surfaceDetailShader: `
    varying vec2 vUv;
    uniform sampler2D uDensityTexture;
    uniform sampler2D uFlowMapTexture;
    uniform vec2 uTexelSize;
    uniform float uTime;

    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
    float snoise(vec2 v) {
        const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy) );
        vec2 x0 = v -   i + dot(i, C.xx);
        vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m = m*m; m = m*m;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
    }

    float fbm(vec2 uv, float flow_mag) {
        float total = 0.0;
        float amplitude = 0.6;
        float frequency = 20.0;
        float gain = 0.4;
        float time_mult = 1.0 + flow_mag * 5.0;
        for (int i = 0; i < 4; i++) {
            total += snoise(uv * frequency + uTime * 0.4 * time_mult) * amplitude;
            frequency *= 2.1;
            amplitude *= gain;
        }
        return total;
    }

    void main() {
        float density = texture2D(uDensityTexture, vUv).g;
        if (density < 0.01) {
            gl_FragColor = vec4(0.5, 0.5, 1.0, 1.0);
            return;
        }
        vec2 flow = texture2D(uFlowMapTexture, vUv).xy * 0.5;
        float flow_mag = length(flow);
        
        float h_l = texture2D(uDensityTexture, vUv - vec2(uTexelSize.x, 0.0)).g;
        float h_r = texture2D(uDensityTexture, vUv + vec2(uTexelSize.x, 0.0)).g;
        float h_b = texture2D(uDensityTexture, vUv - vec2(0.0, uTexelSize.y)).g;
        float h_t = texture2D(uDensityTexture, vUv + vec2(0.0, uTexelSize.y)).g;
        vec2 main_normal = vec2(h_l - h_r, h_b - h_t);

        vec2 sample_uv = vUv + flow + main_normal * 0.01;
        float noise_mod = 1.0 + density * 2.0;
        float noise_val = fbm(sample_uv * noise_mod, flow_mag);

        vec2 dUv = uTexelSize * 2.0;
        float nx = fbm((sample_uv + vec2(dUv.x, 0.0)) * noise_mod, flow_mag);
        float ny = fbm((sample_uv + vec2(0.0, dUv.y)) * noise_mod, flow_mag);
        
        vec3 normal = normalize(vec3((noise_val - nx), (noise_val - ny), 0.5));
        float strength = smoothstep(0.0, 0.1, density);
        
        gl_FragColor = vec4(mix(vec2(0.5), normal.xy * 0.5 + 0.5, strength), 1.0, 1.0);
    }
`,

rippleSplatShader: `
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float uAspectRatio;
    uniform vec2 uCenter;
    uniform vec2 uPrevCenter;
    uniform float uRadius;
    uniform float uStrength;

    float distToSegment(vec2 P, vec2 A, vec2 B) {
        vec2 AP = P - A;
        vec2 AB = B - A;
        float ab2 = dot(AB, AB);
        if (ab2 < 0.00001) return distance(P, A);
        float t = clamp(dot(AP, AB) / ab2, 0.0, 1.0);
        return distance(P, A + t * AB);
    }

    void main() {
        vec2 p = vUv;
        p.x *= uAspectRatio;
        vec2 center = uCenter;
        center.x *= uAspectRatio;
        vec2 prevCenter = uPrevCenter;
        prevCenter.x *= uAspectRatio;
        
        float intensity = 0.0;
        if (distance(center, prevCenter) < 0.0001) {
            float dist_to_center = distance(p, center);
            float radius = uRadius * 0.7;
            float drop = -pow(1.0 - smoothstep(0.0, radius, dist_to_center), 2.0) * 1.5;
            float ring_dist = abs(dist_to_center - radius * 0.5);
            float ring = pow(1.0 - smoothstep(0.0, radius * 0.4, ring_dist), 2.0);
            intensity = (drop + ring * 0.5) * uStrength * 2.5; 
        } else {
            float dist = distToSegment(p, prevCenter, center);
            intensity = -pow(1.0 - smoothstep(0.0, uRadius * 0.5, dist), 1.5) * uStrength;
        }

        vec2 base = texture2D(uTarget, vUv).rg;
        base.r += intensity;
        gl_FragColor = vec4(base, 0.0, 1.0);
    }
`,

ripplePropagateShader: `
    varying vec2 vUv;
    uniform sampler2D uRippleTexture;
    uniform vec2 uTexelSize;
    uniform float uRippleSpeed;
    uniform float uRippleDamping;

    void main() {
        vec2 prevState = texture2D(uRippleTexture, vUv).rg;
        float h_prev = prevState.g;
        float h_curr = prevState.r;

        float h_l = texture2D(uRippleTexture, vUv - vec2(uTexelSize.x, 0.0)).r;
        float h_r = texture2D(uRippleTexture, vUv + vec2(uTexelSize.x, 0.0)).r;
        float h_b = texture2D(uRippleTexture, vUv - vec2(0.0, uTexelSize.y)).r;
        float h_t = texture2D(uRippleTexture, vUv + vec2(0.0, uTexelSize.y)).r;

        float laplacian = (h_l + h_r + h_b + h_t) - 4.0 * h_curr;
        float h_new = 2.0 * h_curr - h_prev + laplacian * (uRippleSpeed * uRippleSpeed) * 0.4;
        h_new *= uRippleDamping;

        gl_FragColor = vec4(h_new, h_curr, 0.0, 1.0);
    }
`,

compositingShader: `
  varying vec2 vUv;
  uniform sampler2D uSceneTexture;
  uniform sampler2D uVelocityTexture;
  uniform sampler2D uDensityTexture;
  uniform sampler2D uTemperatureTexture;
  uniform sampler2D uReflectionTexture;
  uniform sampler2D uDetailNormalTexture;
  uniform sampler2D uRippleTexture;
  uniform vec2 uTexelSize;

  uniform vec3 uLight1Pos;
  uniform vec3 uLight1Color;
  uniform vec3 uLight2Pos;
  uniform vec3 uLight2Color;

  uniform float uDisplacementScale;
  uniform float uVelocityShiftScale;
  uniform float uDensityShiftScale;
  uniform vec3 uWaterColor;
  uniform float uVolumeFactor;
  uniform float uInkStrength;
  uniform float uShininess;
  uniform vec3 uFresnelColor;
  uniform float uFresnelIntensity;
  uniform vec3 uGlowColor;
  uniform float uGlowPower;
  uniform float uWaveSteepness;
  uniform float uWaveComplexity;
  uniform float uWaveDetail;
  uniform float uAmbientTemperature;
  uniform float uBorderThickness;
  uniform vec3 uBorderColor;
  uniform float uChiselStrength;
  uniform float uSSR_Strength;
  uniform float uSSR_Falloff;
  uniform float uSSR_Samples;
  uniform float uSurfaceDetailStrength;
  uniform float uRippleStrength;

  float noise(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec2 velocity = texture2D(uVelocityTexture, vUv).xy;
    float mainDensity = texture2D(uDensityTexture, vUv).g;
    
    if (mainDensity < 0.001) {
      gl_FragColor = texture2D(uSceneTexture, vUv);
      return;
    }
    
    float inkPower = clamp(mainDensity * uInkStrength, 0.0, 1.0);

    vec2 dUv_x = vec2(uTexelSize.x * 2.0, 0.0);
    vec2 dUv_y = vec2(0.0, uTexelSize.y * 2.0);
    float h_x = texture2D(uDensityTexture, vUv + dUv_x).g - mainDensity;
    float h_y = texture2D(uDensityTexture, vUv + dUv_y).g - mainDensity;

    h_x += velocity.x * uWaveComplexity;
    h_y += velocity.y * uWaveComplexity;

    float detail_noise = noise(vUv * 200.0) - 0.5;
    h_x += detail_noise * uWaveDetail;
    h_y += detail_noise * uWaveDetail;
    
    vec3 normalG = vec3(h_x, h_y, uWaveSteepness);

    vec2 detailNormal = (texture2D(uDetailNormalTexture, vUv).xy - 0.5) * 2.0;

    float ripple_h_center = texture2D(uRippleTexture, vUv).r;
    float ripple_h_x = texture2D(uRippleTexture, vUv + dUv_x).r;
    float ripple_h_y = texture2D(uRippleTexture, vUv + dUv_y).r;
    vec2 rippleNormal = vec2(ripple_h_center - ripple_h_x, ripple_h_center - ripple_h_y) * 450.0;

    vec3 finalNormal = normalize(vec3(normalG.xy + detailNormal * uSurfaceDetailStrength + rippleNormal * uRippleStrength, normalG.z));

    vec2 velocityRefraction = velocity * uDisplacementScale;
    vec2 normalRefraction = finalNormal.xy * uDisplacementScale * 0.2;
    vec2 refractionOffset = (velocityRefraction + normalRefraction) * inkPower;
    vec2 refractedUv = vUv - refractionOffset;

    float poweredRgbShift = (length(velocity) * uVelocityShiftScale + mainDensity * uDensityShiftScale) * inkPower;
    vec2 bgShift = vec2(poweredRgbShift, 0.0);
    vec3 refractedBg = vec3(texture2D(uSceneTexture, refractedUv - bgShift).r, texture2D(uSceneTexture, refractedUv).g, texture2D(uSceneTexture, refractedUv + bgShift).b);

    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 surfacePos = vec3(vUv, 0.0);
    vec3 lightDir1 = normalize(uLight1Pos - surfacePos);
    vec3 halfDir1 = normalize(lightDir1 + viewDir);
    vec3 lightDir2 = normalize(uLight2Pos - surfacePos);
    vec3 halfDir2 = normalize(lightDir2 + viewDir);

    float VdotN = clamp(dot(viewDir, finalNormal), 0.0, 1.0);
    float fresnel = pow(1.0 - VdotN, 2.5) + (uFresnelIntensity * 0.3) * pow(1.0 - VdotN, 6.0);
    
    float shininess = min(uShininess, 1024.0);
    float spec1 = pow(max(0.0, dot(finalNormal, halfDir1)), shininess);
    float spec2 = pow(max(0.0, dot(finalNormal, halfDir2)), shininess);

    vec3 specularColor = spec1 * uLight1Color + spec2 * uLight2Color;
    vec3 fresnelComponent = uFresnelColor * fresnel;

    vec3 reflectionColor = vec3(0.0);
    if (uSSR_Strength > 0.0 && uSSR_Samples > 0.0) {
        vec3 reflect_dir = reflect(-viewDir, finalNormal);
        float reflect_dist = 0.0;
        float step_size = 0.01;
        for (int i = 0; i < 30; i++) {
            if (float(i) >= uSSR_Samples) break;
            reflect_dist += step_size;
            vec2 reflect_uv = vUv + reflect_dir.xy * reflect_dist;
            if (reflect_uv.x < 0.0 || reflect_uv.x > 1.0 || reflect_uv.y < 0.0 || reflect_uv.y > 1.0) break;
            
            float ray_height = mainDensity + reflect_dir.z * reflect_dist * 5.0;
            if (texture2D(uDensityTexture, reflect_uv).g > ray_height) {
                reflectionColor = texture2D(uReflectionTexture, reflect_uv).rgb * pow(max(0.0, 1.0 - reflect_dist), uSSR_Falloff);
                break;
            }
        }
    }
    vec3 reflectionComponent = reflectionColor * uSSR_Strength * fresnel;

    float densityR = texture2D(uDensityTexture, vUv - bgShift).g;
    float densityG = mainDensity;
    float densityB = texture2D(uDensityTexture, vUv + bgShift).g;
    
    float glowPower = min(uGlowPower, 10.0);

    float temp = texture2D(uTemperatureTexture, vUv).r;
    float heat = clamp((temp - uAmbientTemperature) / max(0.01, uAmbientTemperature + 1.0), 0.0, 1.0);
    vec3 heatGlowColor = mix(uGlowColor, vec3(1.0, 0.2, 0.0), heat * heat);

    vec3 fluidAdditiveColor = vec3(
      (fresnelComponent.r + specularColor.r + heatGlowColor.r * pow(densityR, glowPower)) * densityR,
      (fresnelComponent.g + specularColor.g + heatGlowColor.g * pow(densityG, glowPower)) * densityG,
      (fresnelComponent.b + specularColor.b + heatGlowColor.b * pow(densityB, glowPower)) * densityB
    ) + reflectionComponent;

    float ao = 0.0;
    if (uChiselStrength > 0.0) {
      float totalDensity = 0.0;
      const float samples = 8.0;
      float angleStep = 6.28318530718 / samples;
      float radius = uTexelSize.y * 5.0;
      for (float i = 0.0; i < samples; i++) {
        totalDensity += texture2D(uDensityTexture, vUv + vec2(cos(i * angleStep), sin(i * angleStep)) * radius).g;
      }
      ao = clamp((totalDensity / samples - mainDensity) * uChiselStrength, 0.0, 1.0);
    }
    float chiselFactor = 1.0 - pow(ao, 1.5) * inkPower;

    vec3 fluidBody = vec3(
        refractedBg.r * mix(1.0, uWaterColor.r, clamp(densityR * uVolumeFactor, 0.0, 1.0)),
        refractedBg.g * mix(1.0, uWaterColor.g, clamp(densityG * uVolumeFactor, 0.0, 1.0)),
        refractedBg.b * mix(1.0, uWaterColor.b, clamp(densityB * uVolumeFactor, 0.0, 1.0))
    ) * chiselFactor;
    
    vec3 finalColor = fluidBody + fluidAdditiveColor;

    if (uBorderThickness > 0.001) {
        float edgeFactor = smoothstep(0.1, 0.1 + uBorderThickness, length(finalNormal.xy));
        finalColor = mix(finalColor, uBorderColor, edgeFactor * inkPower);
    }

    gl_FragColor = vec4(finalColor, 1.0);
  }
`,

finalPassShader: `
    varying vec2 vUv;
    uniform sampler2D uFluidResult;
    uniform sampler2D uSceneTexture;
    uniform sampler2D uDensityTexture;
    uniform sampler2D uCausticsTexture;
    uniform float uArtisticBlend;
    uniform float uCausticsIntensity;

    void main() {
        vec3 fluidView = texture2D(uFluidResult, vUv).rgb;
        vec3 sceneView = texture2D(uSceneTexture, vUv).rgb;
        float density = texture2D(uDensityTexture, vUv).g;
        float caustics = texture2D(uCausticsTexture, vUv).r;

        vec3 sceneWithCaustics = sceneView + caustics * uCausticsIntensity;
        vec3 artisticResult = mix(sceneWithCaustics, fluidView, density);
        vec3 blendedColor = mix(fluidView, artisticResult, uArtisticBlend);
        
        gl_FragColor = vec4(blendedColor, 1.0);
    }
`
};

// --- SIMULATION HOOK ---
type PointerInfo = {
    id: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    button: number;
    type: string;
};

const isColor = (key: string): boolean => key.toLowerCase().includes('color');

export const useFluidSimulation = (
    mountRef: React.RefObject<HTMLDivElement>,
    params: AllParams,
    quality: QualitySettings,
    textureCanvas: HTMLCanvasElement | null,
) => {
    // This ref holds the latest TARGET parameters from props.
    const targetParamsRef = useRef(params);
    useEffect(() => { targetParamsRef.current = params; }, [params]);

    // This ref holds the LIVE, animated parameters being used by the simulation.
    // It's initialized once with the initial params and reset if the hook remounts.
    const liveParamsRef = useRef<AllParams>(JSON.parse(JSON.stringify(params)));

    const sim = useRef({
        renderer: null as THREE.WebGLRenderer | null,
        scene: new THREE.Scene(),
        camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
        particleScene: new THREE.Scene(),
        mesh: new THREE.Mesh(new THREE.PlaneGeometry(2, 2)),
        startTime: 0,
        lastTime: 0,
        pointers: new Map<number, PointerInfo>(),
        fbo: {} as Record<string, any>,
        materials: {} as Record<string, THREE.Material>,
        simHeight: 0,
        config: { waveDecay: 0, densityDissipation: 0, temperatureDissipation: 0 },
    }).current;

    useEffect(() => {
        if (sim.renderer && sim.materials.scene && textureCanvas) {
            const sceneMaterial = sim.materials.scene as THREE.MeshBasicMaterial;
            const newSceneTexture = new THREE.CanvasTexture(textureCanvas);
            newSceneTexture.colorSpace = THREE.SRGBColorSpace;
            sceneMaterial.map?.dispose();
            sceneMaterial.map = newSceneTexture;
            sceneMaterial.needsUpdate = true;
        }
    }, [textureCanvas]);

    useEffect(() => {
        if (!mountRef.current || sim.renderer) return;

        // On remount (e.g., quality change), reset live params to match new targets.
        liveParamsRef.current = JSON.parse(JSON.stringify(targetParamsRef.current));

        const createFBO = (width: number, height: number, format: THREE.PixelFormat = THREE.RGBAFormat) => {
            const fbo = new THREE.WebGLRenderTarget(width, height, {
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                type: THREE.HalfFloatType, format: format,
            });
            const fbo2 = fbo.clone();
            return { read: fbo, write: fbo2, swap: function() { const temp = this.read; this.read = this.write; this.write = temp; } };
        };

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.style.touchAction = 'none';
        mountRef.current.appendChild(renderer.domElement);
        sim.renderer = renderer;

        const { width, height } = renderer.getSize(new THREE.Vector2());
        const simWidth = quality.simResolution;
        const simHeight = Math.round(quality.simResolution / (width / height));
        sim.simHeight = simHeight;

        sim.fbo = {
            velocity: createFBO(simWidth, simHeight),
            density: createFBO(simWidth, simHeight),
            temperature: createFBO(simWidth, simHeight),
            pressure: createFBO(simWidth, simHeight),
            flow: createFBO(simWidth, simHeight),
            ripples: createFBO(simWidth, simHeight, THREE.RGFormat),
            divergence: new THREE.WebGLRenderTarget(simWidth, simHeight, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType, format: THREE.RedFormat }),
            curl: new THREE.WebGLRenderTarget(simWidth, simHeight, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType, format: THREE.RedFormat }),
            caustics: new THREE.WebGLRenderTarget(simWidth, simHeight, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, format: THREE.RedFormat }),
            detailNormal: new THREE.WebGLRenderTarget(simWidth, simHeight, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, format: THREE.RGBAFormat }),
            scene: new THREE.WebGLRenderTarget(width, height, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, format: THREE.RGBAFormat }),
            composited: new THREE.WebGLRenderTarget(width, height, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, format: THREE.RGBAFormat }),
            renderedFrame: createFBO(width, height),
        };

        if (quality.particleResolution > 0) {
            sim.fbo.particles = createFBO(quality.particleResolution, quality.particleResolution);
        }
        
        const simTexelSize = new THREE.Vector2(1 / simWidth, 1 / simHeight);
        
        sim.materials = {
            clear: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.clearShader, uniforms: { uTexture: { value: null }, uValue: { value: 0.97 }, uClearColor: { value: new THREE.Vector3() }, uUseClearColor: { value: false } } }),
            copy: new THREE.MeshBasicMaterial({ map: null }),
            splat: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.splatShader, uniforms: { uTarget: { value: null }, uAspectRatio: { value: width/height }, uColor: { value: new THREE.Vector3() }, uCenter: { value: new THREE.Vector2() }, uRadius: { value: 0.05 } } }),
            erase: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.eraseShader, uniforms: { uTarget: { value: null }, uAspectRatio: { value: width/height }, uCenter: { value: new THREE.Vector2() }, uRadius: { value: 0.05 }, uStrength: { value: 0.1 } } }),
            radialPush: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.radialPushShader, uniforms: { uTarget: { value: null }, uAspectRatio: { value: width/height }, uCenter: { value: new THREE.Vector2() }, uRadius: { value: 0.05 }, uStrength: { value: 0.2 } } }),
            advection: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.advectionShader, uniforms: { uVelocity: { value: null }, uSource: { value: null }, uTexelSize: { value: simTexelSize }, uDt: { value: 0.0 }, uDissipation: { value: 1.0 } } }),
            divergence: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.divergenceShader, uniforms: { uVelocity: { value: null }, uTexelSize: { value: simTexelSize } } }),
            pressure: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.pressureShader, uniforms: { uPressure: { value: null }, uDivergence: { value: null }, uTexelSize: { value: simTexelSize } } }),
            gradientSubtract: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.gradientSubtractShader, uniforms: { uPressure: { value: null }, uVelocity: { value: null }, uTexelSize: { value: simTexelSize } } }),
            reactionDiffusion: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.reactionDiffusionShader, uniforms: { uChemicals: { value: null }, uTexelSize: { value: simTexelSize }, uFeedRate: { value: 0.0 }, uKillRate: { value: 0.0 } } }),
            curl: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.curlShader, uniforms: { uVelocity: { value: null }, uTexelSize: { value: simTexelSize } } }),
            vorticity: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.vorticityShader, uniforms: { uVelocity: { value: null }, uCurl: { value: null }, uVorticity: { value: 0.0 }, uDt: { value: 0.0 }, uTexelSize: { value: simTexelSize } } }),
            surfaceTension: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.surfaceTensionShader, uniforms: { uVelocity: { value: null }, uDensity: { value: null }, uSurfaceTension: { value: 0.0 }, uDt: { value: 0.0 }, uTexelSize: { value: simTexelSize } } }),
            reactionForce: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.reactionForceShader, uniforms: { uVelocity: { value: null }, uChemicals: { value: null }, uReactionForce: { value: 0.0 }, uTexelSize: { value: simTexelSize } } }),
            buoyancy: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.buoyancyShader, uniforms: { uVelocity: { value: null }, uTemperature: { value: null }, uBuoyancy: { value: 0.0 }, uAmbientTemperature: { value: 0.0 }, uDt: { value: 0.0 } } }),
            caustics: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.causticsShader, uniforms: { uDensityTexture: { value: null }, uTexelSize: { value: simTexelSize } } }),
            flowMap: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.flowMapShader, uniforms: { uVelocity: { value: null }, uFlowMap: { value: null }, uFlowSpeed: { value: 0.0 }, uDt: { value: 0.0 } } }),
            surfaceDetail: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.surfaceDetailShader, uniforms: { uDensityTexture: { value: null }, uFlowMapTexture: { value: null }, uTexelSize: { value: simTexelSize }, uTime: { value: 0.0 } } }),
            rippleSplat: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.rippleSplatShader, uniforms: { uTarget: { value: null }, uAspectRatio: { value: width/height }, uCenter: { value: new THREE.Vector2() }, uPrevCenter: { value: new THREE.Vector2() }, uRadius: { value: 0.05 }, uStrength: { value: 0.1 } } }),
            ripplePropagate: new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.ripplePropagateShader, uniforms: { uRippleTexture: { value: null }, uTexelSize: { value: simTexelSize }, uRippleSpeed: { value: 0.5 }, uRippleDamping: { value: 0.99 } } }),
            scene: new THREE.MeshBasicMaterial({ map: textureCanvas ? new THREE.CanvasTexture(textureCanvas) : null }),
            compositing: new THREE.ShaderMaterial({
                vertexShader: shaders.baseVertexShader, fragmentShader: shaders.compositingShader,
                uniforms: THREE.UniformsUtils.merge([
                    THREE.UniformsLib.lights,
                    {
                    uSceneTexture: { value: null }, uVelocityTexture: { value: null }, uDensityTexture: { value: null }, uTemperatureTexture: { value: null }, uReflectionTexture: { value: null }, uDetailNormalTexture: { value: null }, uRippleTexture: { value: null }, uTexelSize: { value: simTexelSize },
                    uLight1Pos: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uLight1Color: { value: new THREE.Color(1.0, 1.0, 1.0) }, uLight2Pos: { value: new THREE.Vector3(-0.5, -0.5, 0.5) }, uLight2Color: { value: new THREE.Color(0.2, 0.5, 1.0) },
                    uDisplacementScale: { value: 0.0 }, uVelocityShiftScale: { value: 0.0 }, uDensityShiftScale: { value: 0.0 }, uWaterColor: { value: new THREE.Color(0.0, 0.0, 0.0) }, uVolumeFactor: { value: 0.0 }, uInkStrength: { value: 0.0 }, uShininess: { value: 0.0 }, uFresnelColor: { value: new THREE.Color(0.0, 0.0, 0.0) }, uFresnelIntensity: { value: 0.0 }, uGlowColor: { value: new THREE.Color(0.0, 0.0, 0.0) }, uGlowPower: { value: 0.0 }, uWaveSteepness: { value: 0.05 }, uWaveComplexity: { value: 0.0 }, uWaveDetail: { value: 0.0 }, uAmbientTemperature: { value: 0.0 }, uBorderThickness: { value: 0.0 }, uBorderColor: { value: new THREE.Color(0,0,0) }, uChiselStrength: { value: 0.0 }, uSSR_Strength: { value: 0.0 }, uSSR_Falloff: { value: 0.0 }, uSSR_Samples: { value: 0.0 }, uSurfaceDetailStrength: { value: 0.0 }, uRippleStrength: { value: 0.0 },
                    }
                ])
            }),
            finalPass: new THREE.ShaderMaterial({
                vertexShader: shaders.baseVertexShader, fragmentShader: shaders.finalPassShader,
                uniforms: { uFluidResult: { value: null }, uSceneTexture: { value: null }, uDensityTexture: { value: null }, uCausticsTexture: { value: null }, uArtisticBlend: { value: 0.0 }, uCausticsIntensity: { value: 0.0 } }
            }),
        };

        if (quality.particleResolution > 0) {
            sim.materials.particleSplat = new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.particleSplatShader, uniforms: { uTarget: { value: null }, uCenter: { value: new THREE.Vector2() }, uRadius: { value: 0.05 }, uIntensity: { value: 0.0 } } });
            sim.materials.particleUpdate = new THREE.ShaderMaterial({ vertexShader: shaders.baseVertexShader, fragmentShader: shaders.particleUpdateShader, uniforms: { uParticles: { value: null }, uVelocity: { value: null }, uDt: { value: 0.0 }, uParticleAdvection: { value: 0.2 } } });
            sim.materials.particleRender = new THREE.ShaderMaterial({ vertexShader: shaders.particleRenderVS, fragmentShader: shaders.particleRenderFS, uniforms: { uParticles: { value: null }, uParticleColor: { value: new THREE.Color(1,1,1) }, uParticleSize: { value: 2.0 } }, transparent: true, blending: THREE.AdditiveBlending, depthTest: false });

            const particleCount = quality.particleResolution * quality.particleResolution;
            const particleGeometry = new THREE.BufferGeometry();
            const particleUvs = new Float32Array(particleCount * 2);
            for (let i = 0; i < quality.particleResolution; i++) {
                for (let j = 0; j < quality.particleResolution; j++) {
                    const index = (i * quality.particleResolution + j) * 2;
                    particleUvs[index] = j / (quality.particleResolution - 1);
                    particleUvs[index + 1] = i / (quality.particleResolution - 1);
                }
            }
            particleGeometry.setAttribute('a_uv', new THREE.BufferAttribute(particleUvs, 2));
            const particlePoints = new THREE.Points(particleGeometry, sim.materials.particleRender);
            sim.particleScene.add(particlePoints);
        }

        sim.scene.add(sim.mesh);
        
        const blit = (target: THREE.WebGLRenderTarget | null, material: THREE.Material) => {
            sim.mesh.material = material;
            sim.renderer!.setRenderTarget(target);
            sim.renderer!.render(sim.scene, sim.camera);
        };
        
        const clearMaterial = sim.materials.clear as THREE.ShaderMaterial;
        clearMaterial.uniforms.uUseClearColor.value = true;
        clearMaterial.uniforms.uClearColor.value.set(1.0, 0.0, 0.0);
        blit(sim.fbo.density.read, clearMaterial);
        blit(sim.fbo.density.write, clearMaterial);
        
        clearMaterial.uniforms.uClearColor.value.set(params.uAmbientTemperature, 0.0, 0.0);
        blit(sim.fbo.temperature.read, clearMaterial);
        blit(sim.fbo.temperature.write, clearMaterial);

        clearMaterial.uniforms.uClearColor.value.set(0.0, 0.0, 0.0);
        blit(sim.fbo.ripples.read, clearMaterial);
        blit(sim.fbo.ripples.write, clearMaterial);
        
        if (quality.particleResolution > 0) {
            clearMaterial.uniforms.uClearColor.value.set(0.0, 0.0, 999, 999);
            blit(sim.fbo.particles.read, clearMaterial);
            blit(sim.fbo.particles.write, clearMaterial);
        }

        clearMaterial.uniforms.uUseClearColor.value = false;
        
        let animationFrameId: number;
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
        const tempColor = new THREE.Color();

        const animate = () => {
            update();
            animationFrameId = requestAnimationFrame(animate);
        };

        const update = () => {
            const now = Date.now();
            const dt = Math.min((now - sim.lastTime) / 1000, 0.0166);
            sim.lastTime = now;
            if (!sim.renderer) return;
            const elapsedTime = (now - sim.startTime) / 1000;

            // --- Motion Engine: Animate parameters ---
            const targetParams = targetParamsRef.current;
            const liveParams = liveParamsRef.current;
            const easing = 0.08;

            for (const key in targetParams) {
                const targetValue = targetParams[key as keyof AllParams];
                const liveValue = liveParams[key as keyof AllParams];
                
                if (typeof targetValue === 'number' && typeof liveValue === 'number') {
                    (liveParams[key as keyof AllParams] as number) = lerp(liveValue, targetValue, easing);
                } else if (
                    typeof targetValue === 'object' && targetValue !== null && 'x' in targetValue &&
                    typeof liveValue === 'object' && liveValue !== null && 'x' in liveValue
                ) {
                    (liveValue as any).x = lerp((liveValue as any).x, (targetValue as any).x, easing);
                    (liveValue as any).y = lerp((liveValue as any).y, (targetValue as any).y, easing);
                    if ('z' in targetValue && 'z' in liveValue) {
                       (liveValue as any).z = lerp((liveValue as any).z, (targetValue as any).z, easing);
                    }
                }
            }
            
            sim.config.waveDecay = liveParams.waveDecay;
            sim.config.densityDissipation = liveParams.densityDissipation;
            sim.config.temperatureDissipation = liveParams.temperatureDissipation;

            // Update shader uniforms every frame with live values
            const allMaterials = Object.values(sim.materials).filter(m => (m as THREE.ShaderMaterial).isShaderMaterial);
            Object.entries(liveParams).forEach(([key, value]) => {
                allMaterials.forEach(mat => {
                    const uniform = (mat as THREE.ShaderMaterial).uniforms?.[key];
                    if (uniform) {
                        if (isColor(key) && typeof targetParamsRef.current[key as keyof AllParams] === 'string') {
                            tempColor.set(targetParamsRef.current[key as keyof AllParams] as string);
                            uniform.value.lerp(tempColor, easing);
                        } else if (key === 'uSSR_Strength') {
                             uniform.value = quality.enableSsr ? (value as number) : 0;
                        } else if (typeof value === 'object' && value !== null && 'x' in value) {
                            uniform.value.set((value as any).x, (value as any).y, (value as any).z);
                        } else {
                            uniform.value = value;
                        }
                    }
                });
                if (key === 'uWaveSize') {
                    ((sim.materials.splat as THREE.ShaderMaterial).uniforms.uRadius as any).value = value;
                }
            });
            
            sim.renderer.setViewport(0, 0, quality.simResolution, sim.simHeight);

            const advectionMaterial = sim.materials.advection as THREE.ShaderMaterial;
            advectionMaterial.uniforms.uDt.value = dt;
            advectionMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            
            advectionMaterial.uniforms.uSource.value = sim.fbo.velocity.read.texture;
            advectionMaterial.uniforms.uDissipation.value = sim.config.waveDecay;
            blit(sim.fbo.velocity.write, advectionMaterial);
            sim.fbo.velocity.swap();
            
            advectionMaterial.uniforms.uSource.value = sim.fbo.density.read.texture;
            advectionMaterial.uniforms.uDissipation.value = sim.config.densityDissipation;
            blit(sim.fbo.density.write, advectionMaterial);
            sim.fbo.density.swap();

            advectionMaterial.uniforms.uSource.value = sim.fbo.temperature.read.texture;
            advectionMaterial.uniforms.uDissipation.value = sim.config.temperatureDissipation;
            blit(sim.fbo.temperature.write, advectionMaterial);
            sim.fbo.temperature.swap();

            const buoyancyMaterial = sim.materials.buoyancy as THREE.ShaderMaterial;
            buoyancyMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            buoyancyMaterial.uniforms.uTemperature.value = sim.fbo.temperature.read.texture;
            buoyancyMaterial.uniforms.uDt.value = dt;
            blit(sim.fbo.velocity.write, buoyancyMaterial);
            sim.fbo.velocity.swap();

            for (const p of sim.pointers.values()) {
                const { button, dx, dy, type } = p;

                if (button === 2) { 
                    const eraseMaterial = sim.materials.erase as THREE.ShaderMaterial;
                    eraseMaterial.uniforms.uTarget.value = sim.fbo.density.read.texture;
                    eraseMaterial.uniforms.uCenter.value.set(p.x, p.y);
                    eraseMaterial.uniforms.uRadius.value = liveParams.uWaveSize * 0.8;
                    eraseMaterial.uniforms.uStrength.value = 0.1;
                    blit(sim.fbo.density.write, eraseMaterial);
                    sim.fbo.density.swap();

                    const radialPushMaterial = sim.materials.radialPush as THREE.ShaderMaterial;
                    radialPushMaterial.uniforms.uTarget.value = sim.fbo.velocity.read.texture;
                    radialPushMaterial.uniforms.uCenter.value.set(p.x, p.y);
                    radialPushMaterial.uniforms.uRadius.value = liveParams.uWaveSize * 1.2;
                    radialPushMaterial.uniforms.uStrength.value = 0.2;
                    blit(sim.fbo.velocity.write, radialPushMaterial);
                    sim.fbo.velocity.swap();

                } else if (Math.abs(dx) > 0 || Math.abs(dy) > 0 || button === 0) { 
                    const splatMaterial = sim.materials.splat as THREE.ShaderMaterial;
                    splatMaterial.uniforms.uCenter.value.set(p.x, p.y);
            
                    splatMaterial.uniforms.uTarget.value = sim.fbo.velocity.read.texture;
                    
                    const isMoving = Math.abs(dx) > 0 || Math.abs(dy) > 0;
                    // For movement, make touch gentle (like hover) and mouse drag strong.
                    const forceMultiplier = (type === 'mouse' && button === 0) ? 2.0 : 1.0;
                    // For stationary interactions, make both mouse click and touch tap strong.
                    const clickIntensity = (!isMoving && button === 0) ? 0.15 : 0.0;
                    
                    splatMaterial.uniforms.uColor.value.set(dx * 100 * forceMultiplier, dy * 100 * forceMultiplier, 0);
                    blit(sim.fbo.velocity.write, splatMaterial);
                    sim.fbo.velocity.swap();
                    
                    const speed = Math.sqrt(dx * dx + dy * dy);
                    const moveIntensity = Math.pow(Math.min(speed * 30.0, 1.0), 2.0) * forceMultiplier;
                    const intensity = moveIntensity + clickIntensity;

                    splatMaterial.uniforms.uTarget.value = sim.fbo.density.read.texture;
                    splatMaterial.uniforms.uColor.value.set(0, intensity * 0.5, 0);
                    blit(sim.fbo.density.write, splatMaterial);
                    sim.fbo.density.swap();
            
                    splatMaterial.uniforms.uTarget.value = sim.fbo.temperature.read.texture;
                    const splatTemp = liveParams.uSplatTemperature;
                    splatMaterial.uniforms.uColor.value.set(splatTemp * intensity, 0, 0);
                    blit(sim.fbo.temperature.write, splatMaterial);
                    sim.fbo.temperature.swap();

                    if (liveParams.uRippleStrength > 0) {
                        const rippleSplatMaterial = sim.materials.rippleSplat as THREE.ShaderMaterial;
                        rippleSplatMaterial.uniforms.uTarget.value = sim.fbo.ripples.read.texture;
                        rippleSplatMaterial.uniforms.uCenter.value.set(p.x, p.y);
                        
                        const prevX = (p.dx === 0 && p.dy === 0) ? p.x : p.x - p.dx;
                        const prevY = (p.dx === 0 && p.dy === 0) ? p.y : p.y - p.dy;
                        rippleSplatMaterial.uniforms.uPrevCenter.value.set(prevX, prevY);
                        
                        rippleSplatMaterial.uniforms.uRadius.value = liveParams.uWaveSize;
                        
                        const hoverStrength = Math.min(speed * 8.0, 0.4);
                        const clickStrength = button === 0 ? 1.0 : 0;
                        rippleSplatMaterial.uniforms.uStrength.value = hoverStrength + clickStrength;
                        
                        blit(sim.fbo.ripples.write, rippleSplatMaterial);
                        sim.fbo.ripples.swap();
                    }

                    if (quality.particleResolution > 0) {
                        const particleRate = liveParams.uParticleRate;
                        if (particleRate > 0) {
                            const particleSplatMaterial = sim.materials.particleSplat as THREE.ShaderMaterial;
                            const particleIntensity = (speed * particleRate) + (button === 0 ? particleRate * 0.5 : 0.0);
                            particleSplatMaterial.uniforms.uTarget.value = sim.fbo.particles.read.texture;
                            particleSplatMaterial.uniforms.uCenter.value.set(p.x, p.y);
                            particleSplatMaterial.uniforms.uRadius.value = liveParams.uWaveSize;
                            particleSplatMaterial.uniforms.uIntensity.value = particleIntensity;
                            blit(sim.fbo.particles.write, particleSplatMaterial);
                            sim.fbo.particles.swap();
                        }
                    }
                }
                p.dx = 0;
                p.dy = 0;
            };
            
            if (quality.particleResolution > 0) {
                sim.renderer.setViewport(0, 0, quality.particleResolution, quality.particleResolution);
                const particleUpdateMaterial = sim.materials.particleUpdate as THREE.ShaderMaterial;
                particleUpdateMaterial.uniforms.uParticles.value = sim.fbo.particles.read.texture;
                particleUpdateMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
                particleUpdateMaterial.uniforms.uDt.value = dt;
                blit(sim.fbo.particles.write, particleUpdateMaterial);
                sim.fbo.particles.swap();
                sim.renderer.setViewport(0, 0, quality.simResolution, sim.simHeight);
            }

            const reactionDiffusionMaterial = sim.materials.reactionDiffusion as THREE.ShaderMaterial;
            reactionDiffusionMaterial.uniforms.uChemicals.value = sim.fbo.density.read.texture;
            for(let i = 0; i < REACTION_DIFFUSION_ITERATIONS; i++) {
                blit(sim.fbo.density.write, reactionDiffusionMaterial);
                sim.fbo.density.swap();
                reactionDiffusionMaterial.uniforms.uChemicals.value = sim.fbo.density.read.texture;
            }

            const reactionForceMaterial = sim.materials.reactionForce as THREE.ShaderMaterial;
            reactionForceMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            reactionForceMaterial.uniforms.uChemicals.value = sim.fbo.density.read.texture;
            blit(sim.fbo.velocity.write, reactionForceMaterial);
            sim.fbo.velocity.swap();

            (sim.materials.curl as THREE.ShaderMaterial).uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            blit(sim.fbo.curl, sim.materials.curl);

            const vorticityMaterial = sim.materials.vorticity as THREE.ShaderMaterial;
            vorticityMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            vorticityMaterial.uniforms.uCurl.value = sim.fbo.curl.texture;
            vorticityMaterial.uniforms.uDt.value = dt;
            blit(sim.fbo.velocity.write, vorticityMaterial);
            sim.fbo.velocity.swap();

            const surfaceTensionMaterial = sim.materials.surfaceTension as THREE.ShaderMaterial;
            surfaceTensionMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            surfaceTensionMaterial.uniforms.uDensity.value = sim.fbo.density.read.texture;
            surfaceTensionMaterial.uniforms.uDt.value = dt;
            blit(sim.fbo.velocity.write, surfaceTensionMaterial);
            sim.fbo.velocity.swap();

            (sim.materials.divergence as THREE.ShaderMaterial).uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            blit(sim.fbo.divergence, sim.materials.divergence);
            
            clearMaterial.uniforms.uTexture.value = sim.fbo.pressure.read.texture;
            clearMaterial.uniforms.uValue.value = 0.0;
            blit(sim.fbo.pressure.write, clearMaterial);
            sim.fbo.pressure.swap();

            const pressureMaterial = sim.materials.pressure as THREE.ShaderMaterial;
            pressureMaterial.uniforms.uDivergence.value = sim.fbo.divergence.texture;
            for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
                pressureMaterial.uniforms.uPressure.value = sim.fbo.pressure.read.texture;
                blit(sim.fbo.pressure.write, pressureMaterial);
                sim.fbo.pressure.swap();
            }

            const gradientSubtractMaterial = sim.materials.gradientSubtract as THREE.ShaderMaterial;
            gradientSubtractMaterial.uniforms.uPressure.value = sim.fbo.pressure.read.texture;
            gradientSubtractMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            blit(sim.fbo.velocity.write, gradientSubtractMaterial);
            sim.fbo.velocity.swap();

            const ripplePropagateMaterial = sim.materials.ripplePropagate as THREE.ShaderMaterial;
            ripplePropagateMaterial.uniforms.uRippleTexture.value = sim.fbo.ripples.read.texture;
            blit(sim.fbo.ripples.write, ripplePropagateMaterial);
            sim.fbo.ripples.swap();

            const flowMapMaterial = sim.materials.flowMap as THREE.ShaderMaterial;
            flowMapMaterial.uniforms.uVelocity.value = sim.fbo.velocity.read.texture;
            flowMapMaterial.uniforms.uFlowMap.value = sim.fbo.flow.read.texture;
            flowMapMaterial.uniforms.uDt.value = dt;
            blit(sim.fbo.flow.write, flowMapMaterial);
            sim.fbo.flow.swap();

            const surfaceDetailMaterial = sim.materials.surfaceDetail as THREE.ShaderMaterial;
            surfaceDetailMaterial.uniforms.uTime.value = elapsedTime;
            surfaceDetailMaterial.uniforms.uDensityTexture.value = sim.fbo.density.read.texture;
            surfaceDetailMaterial.uniforms.uFlowMapTexture.value = sim.fbo.flow.read.texture;
            blit(sim.fbo.detailNormal, surfaceDetailMaterial);

            const causticsMaterial = sim.materials.caustics as THREE.ShaderMaterial;
            causticsMaterial.uniforms.uDensityTexture.value = sim.fbo.density.read.texture;
            blit(sim.fbo.caustics, causticsMaterial);
            
            const { width, height } = sim.renderer.getSize(new THREE.Vector2());
            sim.renderer.setViewport(0, 0, width, height);
            blit(sim.fbo.scene, sim.materials.scene);
            
            const compositingMaterial = sim.materials.compositing as THREE.ShaderMaterial;
            compositingMaterial.uniforms.uSceneTexture.value = sim.fbo.scene.texture;
            compositingMaterial.uniforms.uVelocityTexture.value = sim.fbo.velocity.read.texture;
            compositingMaterial.uniforms.uDensityTexture.value = sim.fbo.density.read.texture;
            compositingMaterial.uniforms.uTemperatureTexture.value = sim.fbo.temperature.read.texture;
            compositingMaterial.uniforms.uReflectionTexture.value = sim.fbo.renderedFrame.read.texture;
            compositingMaterial.uniforms.uDetailNormalTexture.value = sim.fbo.detailNormal.texture;
            compositingMaterial.uniforms.uRippleTexture.value = sim.fbo.ripples.read.texture;
            blit(sim.fbo.composited, compositingMaterial);

            const finalPassMaterial = sim.materials.finalPass as THREE.ShaderMaterial;
            finalPassMaterial.uniforms.uFluidResult.value = sim.fbo.composited.texture;
            finalPassMaterial.uniforms.uSceneTexture.value = sim.fbo.scene.texture;
            finalPassMaterial.uniforms.uDensityTexture.value = sim.fbo.density.read.texture;
            finalPassMaterial.uniforms.uCausticsTexture.value = sim.fbo.caustics.texture;
            blit(sim.fbo.renderedFrame.write, finalPassMaterial);
            
            const copyMaterial = sim.materials.copy as THREE.MeshBasicMaterial;
            copyMaterial.map = sim.fbo.renderedFrame.write.texture;
            blit(null, copyMaterial);
            
            if (quality.particleResolution > 0) {
                (sim.materials.particleRender as THREE.ShaderMaterial).uniforms.uParticles.value = sim.fbo.particles.read.texture;
                renderer.autoClearColor = false;
                renderer.render(sim.particleScene, sim.camera);
                renderer.autoClearColor = true;
            }

            sim.fbo.renderedFrame.swap();
        };

        sim.startTime = sim.lastTime = Date.now();
        sim.pointers = new Map();

        const getPointerPos = (e: PointerEvent) => {
            const rect = (sim.renderer!.domElement as HTMLElement).getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = 1.0 - (e.clientY - rect.top) / rect.height;
            return { x, y };
        };

        const handlePointerDown = (e: PointerEvent) => {
            const { x, y } = getPointerPos(e);
            const pointer = sim.pointers.get(e.pointerId) || { id: e.pointerId, x, y, dx: 0, dy: 0, button: e.button, type: e.pointerType };
            pointer.button = e.button;
            pointer.x = x;
            pointer.y = y;
            pointer.type = e.pointerType;
            sim.pointers.set(e.pointerId, pointer);
        };
        const handlePointerUp = (e: PointerEvent) => sim.pointers.delete(e.pointerId);
        
        const handlePointerMove = (e: PointerEvent) => {
            if (e.buttons === 0 && !e.isPrimary) return;
            const { x, y } = getPointerPos(e);
            let pointer = sim.pointers.get(e.pointerId);
            if (!pointer) {
                handlePointerDown(e);
                pointer = sim.pointers.get(e.pointerId);
            }
            if (pointer) {
                pointer.dx = x - pointer.x;
                pointer.dy = y - pointer.y;
                pointer.x = x;
                pointer.y = y;
                // For mouse hover, set button to -1 to signify a hover state.
                // Touch events will retain their button state from pointerdown.
                if(e.pointerType === 'mouse' && e.buttons === 0) {
                    pointer.button = -1;
                }
            }
        };
        
        // FIX: Replaced anonymous function with a named function reference to ensure correct removal.
        const preventContextMenu = (e: Event) => e.preventDefault();
        
        const domElement = renderer.domElement;
        domElement.addEventListener('pointerdown', handlePointerDown);
        domElement.addEventListener('pointerup', handlePointerUp);
        domElement.addEventListener('pointercancel', handlePointerUp);
        domElement.addEventListener('pointerleave', handlePointerUp);
        domElement.addEventListener('pointermove', handlePointerMove);
        domElement.addEventListener('contextmenu', preventContextMenu);

        const handleResize = () => {
            if (!mountRef.current || !sim.renderer) return;
            const { clientWidth, clientHeight } = mountRef.current;
            renderer.setSize(clientWidth, clientHeight);
            (sim.materials.splat as THREE.ShaderMaterial).uniforms.uAspectRatio.value = clientWidth / clientHeight;
            (sim.materials.erase as THREE.ShaderMaterial).uniforms.uAspectRatio.value = clientWidth / clientHeight;
            (sim.materials.radialPush as THREE.ShaderMaterial).uniforms.uAspectRatio.value = clientWidth / clientHeight;
            (sim.materials.rippleSplat as THREE.ShaderMaterial).uniforms.uAspectRatio.value = clientWidth / clientHeight;
            sim.fbo.scene.setSize(clientWidth, clientHeight);
            sim.fbo.composited.setSize(clientWidth, clientHeight);
            sim.fbo.renderedFrame.read.setSize(clientWidth, clientHeight);
            sim.fbo.renderedFrame.write.setSize(clientWidth, clientHeight);
        };
        window.addEventListener('resize', handleResize);
        
        animate();

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', handleResize);
            domElement.removeEventListener('pointerdown', handlePointerDown);
            domElement.removeEventListener('pointerup', handlePointerUp);
            domElement.removeEventListener('pointercancel', handlePointerUp);
            domElement.removeEventListener('pointerleave', handlePointerUp);
            domElement.removeEventListener('pointermove', handlePointerMove);
            // FIX: Use the same named function for removal.
            domElement.removeEventListener('contextmenu', preventContextMenu);
            Object.values(sim.materials).forEach(material => material?.dispose());
            Object.values(sim.fbo).forEach(fbo => {
                fbo.read?.dispose();
                fbo.write?.dispose();
                fbo.dispose?.();
            });
            (sim.materials.scene as THREE.MeshBasicMaterial)?.map?.dispose();
            renderer.dispose();
            if (mountRef.current && renderer.domElement && mountRef.current.contains(renderer.domElement)) {
                mountRef.current.removeChild(renderer.domElement);
            }
        };
    }, [quality.simResolution, quality.particleResolution]); // Re-run effect only when resolution changes
};