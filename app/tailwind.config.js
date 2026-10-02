/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // Semantic palette. Every token has a light value (DEFAULT) and a
      // `-dark` twin; use them as `bg-canvas dark:bg-canvas-dark`.
      colors: {
        canvas: { DEFAULT: '#f4f5f9', dark: '#0f1115' },
        surface: { DEFAULT: '#ffffff', dark: '#181b22' },
        surface2: { DEFAULT: '#eef0f5', dark: '#222631' },
        ink: { DEFAULT: '#12141a', dark: '#f3f4f8' },
        muted: { DEFAULT: '#5f6675', dark: '#9aa1b2' },
        line: { DEFAULT: '#e3e6ee', dark: '#2a2f3b' },
      },
      borderRadius: { '2xl': 20, '3xl': 28 },
    },
  },
  plugins: [],
};
