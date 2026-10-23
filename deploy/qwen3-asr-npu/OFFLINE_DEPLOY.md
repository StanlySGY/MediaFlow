# Qwen3-ASR 离线 NPU 部署文档（已合并）

> 这份文档的内容已合并进 [DEPLOY.md](DEPLOY.md) 第三节「离线部署（服务器无网络）」。
> 保留这个文件只是为了让旧链接、旧交付清单里的文件名仍能找到去处。

合并原因：两份文档讲的是同一条部署路径，却各自维护一份副本，还给出了互相矛盾的数字
——同一份 `vllm-ascend` 镜像，这里写「约 4-5GB」，`DEPLOY.md` 写「约 8-10GB」，而仓库里
交付用的 `vllm-ascend-v0.22.1rc1.tar.gz` 实测 6.4GB（6,893,164,068 字节）。现场照任何
一份准备介质都可能准备错。合并后以实测值为准，介质切分与校验步骤也一并写全。

| 原来在这里的内容 | 现在在哪里 |
|---|---|
| 环境要求（麒麟 OS、内存 64GB+、显存） | `DEPLOY.md` 一、环境要求 |
| 需要准备的文件与大小 | `DEPLOY.md` 三、离线部署 → 离线部署文件清单 |
| 镜像导出、切分、校验、导入 | `DEPLOY.md` 三、离线部署 步骤 1/3 |
| 模型下载与打包 | `DEPLOY.md` 三、离线部署 步骤 4 |
| 启动与验证 | `DEPLOY.md` 三、离线部署 步骤 5（含 `Uvicorn running` 就绪判定与 `/v1/models`） |
| MediaFlow 侧配置 | `DEPLOY.md` 四、MediaFlow 配置 |
| 常用操作 / 切换 NPU 卡号 / 故障排查 / 版本兼容表 | `DEPLOY.md` 六、七、八 |
| 参考文档 | `DEPLOY.md` 九、参考文档 |

MediaFlow 应用侧的部署、配置与排错见仓库根目录 [DEPLOY_ONSITE.md](../../DEPLOY_ONSITE.md)；
把大镜像切分带进离线现场的逐步操作见 [ONSITE_DEPLOY.md](../../ONSITE_DEPLOY.md)。
