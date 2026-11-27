# 站主写作后台（试行版）

入口：`https://blog.nakanashi.com/admin/`，导航栏中的「写文章」。

## 首次部署

1. 保持 Cloudflare 的 GitHub 连接、`master` 生产分支、`pnpm build` 和 `npx wrangler deploy`。
2. 推送本次变更。`wrangler.toml` 会为原 Worker 增加接口和登录限流绑定，博客仍通过静态资源服务。
3. 在该 Worker 的 Settings → Variables and Secrets 中新增两个 **Secret**：
   - `ADMIN_PASSWORD`：至少 10 个字符的站主密码。
   - `GITHUB_TOKEN`：仅限 `John-River/Firefly`，仓库 Contents 读写权限的 GitHub fine-grained token。
4. 保存并部署，然后在后台登录。不把密码和 token 放到仓库、公开变量或前端代码中。

未配置密码时，接口返回 503 并拒绝登录；未配置 token 时禁止文章读取和发布。
站主密码变更会使之前签发的登录会话失效。登录会话八小时过期。
登录受 Cloudflare Rate Limiting 约束：每个访问 IP 在每个边缘位置每分钟大约六次，非跨位置严格全局限流。

## 写作与发布

- 可视化编辑器使用固定版本 Vditor 4.0.1，从 jsDelivr 加载；支持 Markdown 模式。编辑器加载失败时回退到 Markdown 编辑与安全预览。
- 草稿与待发布图片保存在本机 IndexedDB，不会发送到公开仓库。换浏览器或清理站点数据后不能恢复。
- 支持 PNG、JPEG、GIF、WebP，单张最大 5 MB，一次新图片总计最大 10 MB，最多 20 张。
- 图片在编辑时本机预览，发布时和文章一次提交。试行版不自动删除历史图片。
- 新文章保存为 `src/content/posts/<文章地址>.md`，图片放在 `public/uploads/`。
- 现有 `.md` 文章可打开编辑。`.mdx` 不在编辑列表内，以免可视化编辑器破坏 JSX 组件。
- 其他元数据（例如文章密码、许可证）在修改时保留。文章中的既有相对图片路径保持不变，其后台预览可能受路径限制。
- 发布将写入公开的 master 分支；未发布草稿不要通过其他方式推送到公开仓库。
- 发布后的状态是「已提交，等待部署」，并非部署成功确认。Cloudflare 构建失败时到控制台查看日志；不要重复发布同一篇。
- 编辑冲突不会覆盖仓库；刷新列表、重新打开最新文章后再修改。本机草稿和 Markdown 导出可用于保留编辑内容。
- 后台编辑过文章后，本机进行其他开发前先 `git pull`，避免与后台提交冲突。

## 验证

`node --test worker/admin.test.js` 验证认证、请求来源、图片签名、文章路径、日期、原子提交和提交冲突。
`pnpm build` 构建站点。Astro 的 dev / preview 不执行 Worker 接口，完整后台需使用 Wrangler 或部署环境。

## 回退

将本次提交 revert 并推送，等待 Cloudflare 重新部署；后台已发布的 Markdown 与图片是后续独立提交，不会因此自动删除。
