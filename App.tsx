import React, { useState } from 'react';
import GlassEffect from './components/GlassEffect';
import { useMousePosition } from './hooks/useMousePosition';

const App: React.FC = () => {
  const { x, y, velocity } = useMousePosition();
  const [refrostRate, setRefrostRate] = useState(0.0004);

  const scale = 1 + Math.min(velocity, 50) / 100;

  return (
    <main className="relative flex flex-col items-center justify-center min-h-screen w-full text-white p-4 antialiased overflow-hidden cursor-none">
      
      {/* Custom Cursor */}
      <div 
        className="pointer-events-none fixed z-50 rounded-full transition-transform duration-100 ease-out"
        style={{ 
          left: x, 
          top: y,
          width: '50px',
          height: '50px',
          transform: `translate(-50%, -50%) scale(${scale})`,
          background: 'radial-gradient(circle, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 60%)',
          border: '1px solid rgba(255, 255, 255, 0.3)',
          boxShadow: '0 0 20px 5px rgba(255, 255, 255, 0.1)',
        }}
      />
      
      <div className="z-10 text-center mb-8 px-4 animate-fade-in-up">
        <h1 className="text-4xl md:text-6xl font-light tracking-wider text-gray-200 mb-2" style={{textShadow: '0 2px 20px rgba(0,0,0,0.5)'}}>
          Clarity
        </h1>
        <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto font-light" style={{textShadow: '0 2px 20px rgba(0,0,0,0.5)'}}>
          Wipe away the blur.
        </p>
      </div>

      <div className="relative w-full max-w-4xl aspect-[16/9] shadow-2xl shadow-black/50 rounded-lg overflow-hidden animate-fade-in">
        <GlassEffect 
            imageUrl="https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=2070&auto=format&fit=crop" 
            refrostRate={refrostRate} 
        />
        <div className="absolute inset-0 border border-white/10 rounded-lg pointer-events-none"></div>
      </div>
      
      {/* Glassmorphism Control Panel */}
      <div 
        className="z-10 mt-8 w-full max-w-md text-center animate-fade-in-up p-4 rounded-xl border border-white/10 bg-black/20 backdrop-blur-md" 
        style={{ animationDelay: '0.6s' }}
      >
        <div className="flex items-center justify-between gap-4">
            <label htmlFor="refrost-slider" className="flex-shrink-0 text-sm font-medium text-gray-300 tracking-wide">
                Refrost <span className="hidden sm:inline">Rate</span>
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
            <span className="text-sm text-gray-400 font-mono w-16 text-right">{Number(refrostRate).toFixed(4)}</span>
        </div>
      </div>

    </main>
  );
};

export default App;