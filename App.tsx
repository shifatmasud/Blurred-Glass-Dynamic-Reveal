
import React, { useState } from 'react';
import GlassEffect from './components/GlassEffect';

const App: React.FC = () => {
  const [refrostRate, setRefrostRate] = useState(0.0004);

  return (
    <main className="relative flex flex-col items-center justify-center min-h-screen w-full text-white p-4 antialiased overflow-hidden">
      
      <div className="z-10 text-center mb-8 px-4 animate-fade-in-up">
        <h1 className="text-4xl md:text-6xl font-light tracking-wider text-gray-200 mb-2" style={{textShadow: '0 2px 20px rgba(0,0,0,0.5)'}}>
          Clarity
        </h1>
        <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto font-light" style={{textShadow: '0 2px 20px rgba(0,0,0,0.5)'}}>
          A winter morning. Wipe the frost away and watch as condensation drips down the pane.
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
