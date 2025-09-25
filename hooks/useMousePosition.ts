
import { useState, useEffect, useRef } from 'react';

interface MousePosition {
  x: number;
  y: number;
  velocity: number;
  isTouch: boolean;
}

export const useMousePosition = (): MousePosition => {
  const [mousePosition, setMousePosition] = useState<MousePosition>({ x: -1000, y: -1000, velocity: 0, isTouch: false });

  // Refs to hold the latest mouse position and velocity without causing re-renders in the loop
  const mousePosRef = useRef({ x: -1000, y: -1000 });
  const velocityRef = useRef(0);
  const lastPosRef = useRef({ x: -1000, y: -1000 });
  const isTouchRef = useRef(false);
  
  const animationFrameId = useRef<number | null>(null);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (isTouchRef.current) {
        isTouchRef.current = false;
      }
      mousePosRef.current = { x: event.clientX, y: event.clientY };
    };

    const handleTouch = (event: TouchEvent) => {
      if (!isTouchRef.current) {
        isTouchRef.current = true;
      }
      if (event.touches.length > 0) {
        mousePosRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
    };

    const loop = () => {
        const dx = mousePosRef.current.x - lastPosRef.current.x;
        const dy = mousePosRef.current.y - lastPosRef.current.y;
        const distance = Math.sqrt(dx*dx + dy*dy);

        // Smooth velocity with a low-pass filter (lerp)
        velocityRef.current = velocityRef.current * 0.85 + distance * 0.15;
        lastPosRef.current = { x: mousePosRef.current.x, y: mousePosRef.current.y };
        
        // Update the state to trigger re-render in the component using the hook
        setMousePosition({
            x: mousePosRef.current.x,
            y: mousePosRef.current.y,
            velocity: velocityRef.current,
            isTouch: isTouchRef.current,
        });

        animationFrameId.current = requestAnimationFrame(loop);
    }
    
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchstart', handleTouch);
    window.addEventListener('touchmove', handleTouch);
    
    // Start the animation loop
    animationFrameId.current = requestAnimationFrame(loop);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchstart', handleTouch);
      window.removeEventListener('touchmove', handleTouch);
      if(animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, []);

  return mousePosition;
};
