window.__ModuleLoader__.load({ id: "g5g-probe", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// G6-D 探针客户端（只为沙盒实测）：把宿主的 sidebarRight.openResource 暴露给测试脚本
exports.inject = ['sidebarRight', 'uiWorkspace']
exports.apply = function (ctx) { window.__g6probe = { open: (addr) => { try { ctx.sidebarRight.openResource(addr); return 'ok' } catch (e) { return String(e && e.message || e) } }, openSession: (id) => { try { ctx.uiWorkspace.openSession(id); return 'ok' } catch (e) { return String(e && e.message || e) } } } }
return module.exports; } });
