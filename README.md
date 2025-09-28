# Clarity: Interactive Frosted Glass

[**View Live Demo**](https://sensational-resources-524629.framer.app/)

## tldr; (Explain Like I'm 5)

Imagine a foggy window on a cold day. You can use your finger (or in this case, your mouse cursor) to wipe away the fog and see what's outside. This app does exactly that on your screen! It can show a picture, a GIF, or even a video behind the digital "fog". As you wipe, you can see little water droplets form and drip down, just like on a real window.

---

## Context Map

This project combines React for the user interface with Three.js (WebGL) for the high-performance graphics. The core logic is split to keep things fast and organized.

```
+--------------------------+
|      React UI Layer      |
|       (framer.tsx)       |
|  (Props, State, Hooks)   |
+-------------+------------+
              |
              | Manages
              v
+-------------+------------+
|    ClarityController     |
| (WebGL/Three.js Manager) |
+-------------+------------+
              |
              | Orchestrates
              v
+-------------+------------+      +--------------------------+
|      Render Passes       |----->|     Shader Programs      |
| (Physics, Blur, Main)    |      | (GLSL code for the GPU)  |
+--------------------------+      +--------------------------+
              |
              | Uses
              v
+-------------+------------+
|      Render Targets      |
| (Off-screen canvases)    |
+--------------------------+
```

*   **React UI (`Clarity` component)**: This is the part you see and interact with in Framer. It provides the controls (like changing the image, pointer size, etc.) and manages the overall size and visibility of the component. It's the "brain" that tells the graphics engine what to do.
*   **`ClarityController`**: A pure JavaScript/TypeScript class that handles all the heavy lifting with Three.js. It creates the canvas, loads textures (images/videos), sets up the scenes, and runs the main animation loop. Keeping this separate from React prevents re-renders from slowing down the graphics.
*   **Shader Programs (GLSL)**: These are the heart of the visual effect. They are small programs written in a language called GLSL that run directly on your computer's graphics card (GPU).
    *   `physicsFragmentShader`: This shader simulates the state of the glass pane. It tracks where you've wiped (`clear`), how much "water" has condensed (`water`), and where it's dripping (`drip`). It runs at a lower resolution to be fast.
    *   `mainFragmentShader`: This is the final step. It takes the original image, a blurred version of it, and the data from the physics shader. It then mixes them all together to draw the final result you see on screen, adding effects like reflections, distortion, and chromatic aberration.
*   **Render Passes / Render Targets**: Instead of drawing directly to the screen, we use several off-screen "canvases" called render targets. We first draw the physics simulation to one, then the blurred background to another, and finally combine them all in the main pass that draws to the screen. This is a powerful technique for creating complex visual effects.

---

## Directory Tree

```
.
├── index.html          # Main HTML entry point, includes styles and import maps.
├── index.tsx           # React app entry point, renders the main component.
├── framer.tsx          # Contains the main <Clarity> React component and the ClarityController WebGL class.
├── metadata.json       # Project metadata for the Framer platform.
└── README.md           # You are here!
```

---

[**View Live Demo**](https://sensational-resources-524629.framer.app/)
