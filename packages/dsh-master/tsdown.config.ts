import { defineConfig } from 'tsdown'
export default defineConfig([
  { entry: { index: 'src/index.ts', doctor: 'src/doctor-cli.ts' }, outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: true, fixedExtension: false },
  // 面板客户端：CJS，外包宿主的 ModuleLoader；react 用宿主的
  { entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022', dts: false, clean: false, fixedExtension: false,
    deps: { neverBundle: ['react', 'react-dom', 'react-dom/client', /^@deepseek-ai\//] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-master", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
