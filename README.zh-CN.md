[English](README.md) | **简体中文**

# dsh-owui-chat2api

把 Open WebUI 里的模型接进 DeepSeek Harness Desktop:一个把 Open WebUI 变成
标准 OpenAI 兼容 `/v1` API 的本地反向代理,外加一个内置在 DSH 里的用量面板。

它内置了 [chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api),以本地
反向代理的方式运行,并在 DSH 的页面里注入一个控制面板:

```
DeepSeek Harness(或任何 OpenAI 兼容客户端)
        │       标准 /v1 接口 → http://127.0.0.1:8000
        ▼
   dsh-owui-chat2api   (本地反向代理,自带登录凭据)
        ▼
   你的 Open WebUI     (浏览器登录一次,之后自动复用)
```

## 功能

- 从面板启动 / 停止代理
- 环境检查:Python 是否可用、依赖是否装好
- 配置 Open WebUI 地址、主机、端口
- 用量面板:今天 / 昨天 / 本月 / 累计,按模型排行
- 一键同步模型与推理等级(见[推理等级](#推理等级))
- 进程日志:错误高亮、跟随最新、一键复制

## 快速开始

需要 DeepSeek Harness Desktop。

1. 把插件文件夹放进 `%USERPROFILE%\.dsh\plugins\`
   (例如 `dsh-owui-chat2api-0.7.1`)。
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里加上依赖:

   ```jsonc
   "dependencies": {
     "dsh-owui-chat2api": "link:%USERPROFILE%\\.dsh\\plugins\\dsh-owui-chat2api-0.7.1"
   },
   "dsh": { "profile": { "bundles": [ /* ... */ "dsh-owui-chat2api" ] } }
   ```

   版本号换成你实际放进去的文件夹名即可。
3. 重启 DSH Desktop,右上角出现 **OWUI** 圆标。
4. 打开面板,把 **Open WebUI 地址**改成你自己的(默认是占位符)。
5. 点 **Start**。第一次运行会弹出浏览器窗口,登录一次你的 Open WebUI,
   之后自动复用。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| Diagnostics 显示 **Attention** | 装依赖:`pip install requests playwright`,再 `playwright install` |
| 登录失败 / 提示重新登录 | 面板里点 **Login**,在弹窗里登一次即可 |
| 模型不在 DSH 模型列表里 | 配置区点 **Sync models & reasoning levels**,然后重启 DSH |
| 地址还是 `your-open-webui.example.com` | 那是占位符,改成本机实际地址再 Start |

## 推理等级

推理模型(比如 vLLM 网关后面那种)支持 `reasoning_effort`,DSH 的模型选择器
里对应有 **Off / Low / Medium / High** 四档。

最省事:在面板配置区点一次 **Sync models & reasoning levels**。它会自动探测
模型、给支持推理的模型声明好等级,并且先写一份备份。以后后端上了新模型再
点一次即可(已探测过的会走缓存)。

想手动声明,或独立使用 `chat2api.py`,见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 数据与安全

- 你的 Open WebUI 登录会话(`.chrome-profile`、`token.json`、用量库)
  只保存在本机,已排除出 git 和发布包。
- 用量数据库、代理配置放在 `~/.dsh`(插件目录之外),升级插件不会丢。
- 代理默认只监听 `127.0.0.1`。

## 面向开发者

代码结构、核心约定、如何本地测试改动 → [DEVELOPMENT.md](DEVELOPMENT.md)。

## 许可证

- 插件本体(`chat2api/` 之外):MIT — 见 [LICENSE](LICENSE)。
- 内置 `chat2api/` 代理:MIT © openwebui-chat2api contributors — 见
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与
  [Sozbo-Tang/openwebui-chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api)。
