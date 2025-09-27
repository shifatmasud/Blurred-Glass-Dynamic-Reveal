import React, { useEffect, useRef } from "react"
import { addPropertyControls, ControlType } from "framer"

declare global {
    interface Window {
        $: any
    }
}

const loadRippleScript = (callback: () => void) => {
    if (window.$ && window.$.fn.ripples) {
        callback()
        return
    }
    const loadScript = (src: string, onLoad: () => void) => {
        const script = document.createElement("script")
        script.src = src
        script.async = true
        script.onload = onLoad
        document.body.appendChild(script)
    }
    if (!window.$) {
        loadScript(
            "https://cdn.jsdelivr.net/npm/jquery@3.6.3/dist/jquery.min.js",
            () => {
                loadScript(
                    "https://cdn.jsdelivr.net/npm/jquery.ripples@0.6.3/dist/jquery.ripples.js",
                    callback
                )
            }
        )
    } else {
        loadScript(
            "https://cdn.jsdelivr.net/npm/jquery.ripples@0.6.3/dist/jquery.ripples.js",
            callback
        )
    }
}

/**
 * A component that applies a water ripple effect to an image.
 *
 * @framerIntrinsicWidth 400
 * @framerIntrinsicHeight 300
 * @framerSupportedLayoutWidth "fixed"
 * @framerSupportedLayoutHeight "fixed"
 */
export default function WaterCanvas(props: {
    imageUrl: string
    perturbance: number
    dropRadius: number
    resolution: number
    interactive: boolean
    width: number
    height: number
}) {
    const ref = useRef<HTMLDivElement>(null)

    // Effect for INITIALIZATION and PROP CHANGES (excluding size)
    useEffect(() => {
        loadRippleScript(() => {
            if (!ref.current || typeof window.$.fn.ripples !== "function") {
                return
            }
            const $element = window.$(ref.current)
            $element.ripples("destroy")
            $element.ripples({
                resolution: props.resolution,
                dropRadius: props.dropRadius,
                perturbance: props.perturbance,
                interactive: props.interactive,
                crossOrigin: "anonymous",
            })
        })
        return () => {
            if (
                ref.current &&
                window.$ &&
                typeof window.$.fn.ripples === "function"
            ) {
                window.$(ref.current).ripples("destroy")
            }
        }
    }, [
        props.resolution,
        props.dropRadius,
        props.perturbance,
        props.interactive,
    ])

    // --- NEW EFFECT FOR RESIZING ---
    // This effect specifically handles changes in width and height.
    useEffect(() => {
        if (
            ref.current &&
            window.$ &&
            typeof window.$.fn.ripples === "function"
        ) {
            // Check if the ripples instance exists on the element
            if (window.$(ref.current).data("ripples")) {
                // Tell the plugin to update its internal canvas size
                window.$(ref.current).ripples("updateSize")
            }
        }
    }, [props.width, props.height]) // Only runs when width or height change

    return (
        <div
            ref={ref}
            style={{
                width: props.width,
                height: props.height,
                backgroundImage: `url(${props.imageUrl})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
            }}
        />
    )
}

// Default props and property controls remain the same.
WaterCanvas.defaultProps = {
    width: 400,
    height: 300,
    imageUrl:
        "https://images.unsplash.com/photo-1534790566855-4cb788d389ec?q=80&w=2070&auto.format&fit=crop",
    perturbance: 0.03,
    dropRadius: 20,
    resolution: 256,
    interactive: true,
}

addPropertyControls(WaterCanvas, {
    imageUrl: { title: "Image", type: ControlType.Image },
    interactive: {
        title: "Interactive",
        type: ControlType.Boolean,
        defaultValue: true,
    },
    dropRadius: {
        title: "Drop Radius",
        type: ControlType.Number,
        defaultValue: 20,
        min: 1,
        max: 100,
        step: 1,
        display: "slider",
    },
    perturbance: {
        title: "Perturbance",
        type: ControlType.Number,
        defaultValue: 0.03,
        min: 0,
        max: 0.1,
        step: 0.001,
        display: "slider",
    },
    resolution: {
        title: "Resolution",
        type: ControlType.Number,
        defaultValue: 256,
        min: 128,
        max: 1024,
        step: 64,
    },
})
