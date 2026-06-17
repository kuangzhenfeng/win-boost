/** @type {import('tailwindcss').Config} */
// 柔和暖色卡片主题（亮色）。content 仅扫描实际用到 class 的 html。
module.exports = {
  // 产物输出在 src/web/static，content 相对路径基于运行 cwd（项目根）。
  content: ['./src/web/static/index.html'],
  theme: {
    extend: {
      colors: {
        warm: {
          white: '#FAF8F4',
          sand: '#E8E0D5',
          card: '#FFFFFF',
          ink: '#3A3631',
          soft: '#6B645C',
          line: '#ECE6DC',
        },
        grass: '#6B9E5C',
        amber: '#E0995E',
        slate2: '#8A95A5',
        rust: '#C56B4A',
        saver: '#8A95A5',
        balanced: '#6B9E5C',
        performance: '#E0995E',
        ultimate: '#C56B4A',
      },
      fontFamily: {
        display: ['Fraunces', '"Iowan Old Style"', '"Palatino Linotype"', 'P052', 'Georgia', 'serif'],
        sans: ['Figtree', '"Avenir Next"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Spline Sans Mono"', '"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: '22px',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(58,54,49,.04), 0 10px 28px rgba(58,54,49,.07)',
      },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.35)', opacity: '0.6' },
        },
        pulseHi: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        rise: 'rise .6s cubic-bezier(.2,.7,.2,1) both',
        breathe: 'breathe 2.4s ease-in-out infinite',
        'pulse-hi': 'pulseHi 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
