# Changelog

Earlier versions (0.1.0 – 0.2.3): see the notes on each [GitHub Release](https://github.com/ZhuFrank/dsh-master-plugin/releases).

## 0.2.4

### Security
- **No session can read DSH's credential files any more.** `$DSH_HOME/.credentials.yaml` holds your model API keys and the
  signing key of the web login cookie (with it, a session could sign its own login cookie and call the DSH API). Up to
  0.2.3 any session could read it — members, masters, subagents and ordinary sessions — because the guard only protected
  `$DSH_HOME/logs`. Now `$DSH_HOME/.credentials.yaml`, `$DSH_HOME/.env` and `$DSH_HOME/liveshare/` are refused for every
  session, the master included (it never needs a key). Covered: the `read` / `grep` tools and other tools' path
  arguments, bash and PowerShell (absolute paths, `$DSH_HOME` / `$env:DSH_HOME` / `~`, `cd` or `workdir` followed by a
  relative path, wildcards, `Join-Path`, `.NET` reads, `cmd /c type`, `python -c "open(…)"`), recursive reads or copies of
  `$DSH_HOME` itself (`grep -r`, `rg`, `tar`, `cp -r`, `find -exec`, `Select-String`, `Compress-Archive` …), and
  `heavy_run`. Subagents opened by a member go through the same guard. Writes are refused too.
- New setting `credentialPaths` adds more files or folders to that list (for example if you moved the credentials file).
- The guard is a speed bump, not isolation; what it cannot see is listed under *Known issues* in the README.

### Unchanged
- `$DSH_HOME/logs` is still readable by the master only (`secretPaths`).
- No database migration. Works with DSH 0.2.1 and 0.2.2.

---

# 更新记录

更早的版本（0.1.0 – 0.2.3）：见各个 [GitHub Release](https://github.com/ZhuFrank/dsh-master-plugin/releases) 的说明。

## 0.2.4

### 安全
- **任何会话都读不到 DSH 的凭据文件了。** `$DSH_HOME/.credentials.yaml` 里存着模型 API key 和网页登录 cookie 的签名密钥（拿到它就能自己签出登录 cookie、直接调 DSH 接口）。0.2.3 及以前守卫只管 `$DSH_HOME/logs`，成员、总管、子代理、普通会话都能读这个文件。现在 `$DSH_HOME/.credentials.yaml`、`$DSH_HOME/.env`、`$DSH_HOME/liveshare/` 对所有会话都拦，总管也不例外（它用不着 key）。覆盖：`read` / `grep` 工具和其他工具的路径参数；bash 和 PowerShell（绝对路径、`$DSH_HOME` / `$env:DSH_HOME` / `~`、先 `cd` 或用 `workdir` 再写相对路径、通配符、`Join-Path`、.NET 读法、`cmd /c type`、`python -c "open(…)"`）；对 `$DSH_HOME` 本身的递归读或复制（`grep -r`、`rg`、`tar`、`cp -r`、`find -exec`、`Select-String`、`Compress-Archive` 等）；`heavy_run`。成员开的子代理走同一个守卫。写也一样拦。
- 新配置 `credentialPaths`：往名单里再加文件或目录（比如改过凭据文件的位置）。
- 守卫只是减速带，不是隔离；看不出来的写法列在 README 的「已知问题」里。

### 没变的
- `$DSH_HOME/logs` 仍然只有总管能读（`secretPaths`）。
- 不用迁移数据库。支持 DSH 0.2.1 和 0.2.2。
