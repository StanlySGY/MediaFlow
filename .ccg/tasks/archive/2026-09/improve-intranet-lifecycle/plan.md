# 实施计划

1. 读取项目规范和相关后端/前端/CI/配置文件，确认现有 API 契约和测试模式。
2. 并行获取 Antigravity 与 Claude 的实现分析；记录可行方案和风险。
3. 先为任务取消、实时 session 清理/容量、累计音频配额和配置文件卫生补测试，再实施后端修复。
4. 更新前端 `resetTask`、实时异常清理、mock 状态提示、字体加载；修复 lint/Ruff 并补 CI 检查。
5. 运行后端测试、前端测试/build/lint、Ruff、Compose 配置和差异检查。
6. 并行进行双模型代码审查，处理 Critical/Warning，写入 review.md。
7. 更新任务状态，归档 `.ccg/tasks` 元数据并提交；不提交用户业务文件或真实 `.env`。
