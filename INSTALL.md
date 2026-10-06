# dsh-bg-atelier-plus —— 官方版分支（安装 / 验证 / 回退）

「底图工坊」的**官方客户端适配分支**，从原插件 `dsh-bg-atelier 1.15.2` 复制出来改的。

- 原插件目录：`E:\dsh-plugins\dsh-desktop-wallpaper`（**一个字没改**；社区版与回退都用它）
- 本分支目录：`E:\dsh-plugins\dsh-bg-atelier-official`（包名 `dsh-bg-atelier-plus`）
- 原版自己的安装说明在 GitHub 仓库 README，与本文件无关

## 装在哪

| profile | 现状 |
| --- | --- |
| `desktop`（本机官方客户端启动时用的就是它） | 已挂 `dsh-bg-atelier-plus`；原 `dsh-bg-atelier` 已从 bundles 里摘掉 |
| `web`（官方 app 代码里的默认值，本机没用上） | 也装了一份，无害 |

两个 profile 里都**不会同时挂两个底图插件**。

## 重启 DSH Desktop 后要看的日志

启动日志里找这两行：

```
[dsh-bg-atelier] host up (v1.16.0), serving ...
[dsh-bg-atelier] sharp unavailable, serving originals.   ← 出现这行才是问题
```

出现 `sharp unavailable` 说明宿主自带的 sharp 没被找到（那 `?sz=preview` / `?sz=large`
会退化成送原图，两段式加载失效）。修法：启动前设置环境变量指向任意一份 sharp 入口：

```
DSH_BG_ATELIER_SHARP=C:\Users\陈道云\.dsh\profiles\node_modules\sharp\dist\index.cjs
```

## 回退（一分钟）

1. 打开 `C:\Users\陈道云\.dsh\profiles\desktop\package.json`，把 `bundles` 里的
   `dsh-bg-atelier-plus` 换回 `dsh-bg-atelier`；
2. 备份文件就在同目录（改动前的原样）：
   - `package.json.bak-bgaplus-20261001-142711`
   - `cordis.patch.yml.bak-bgaplus-20261001-142711`
3. 重启 DSH Desktop。

原插件从没被改动过，换回去就是原来的行为。

## 改了什么（相对原版 1.15.2）

1. **界面底色不再发白**：浅色主题下 `--dsw-alias-bg-base` 等一批表面 token 原来是
   「深色底往白提亮 96%」（近白薄纱 —— 就是「底图上盖了层白布」）。现在提亮 60%，
   面透明度由新设置项「表面不透明度」单独控制（**0–30%，默认 30%**）。
   深色主题那套值一个字没动。
2. **高清底图先预览后升清**：点大图先请求 `?sz=preview`（实测 16–40 KB）立刻上屏，
   再后台加载 `?sz=large`（host 侧把长边 >3840 的原图缩成 3840 的 webp，实测 400–900 KB），
   好了再换上去。本机「高清」目录 157 张单张 15–80 MB，原来一把梭原图。
   设置页可关（「高清底图先出预览图，再升清」）。
3. **对话特效跟输入框卡面同宽**：特效画布所在的宿主 slot 是居中收缩的 flex 行，原来量出来
   只有 194px（整行 434px），粒子按 194px 算密度只剩 6 只、超出 194px 的还被 clip 切掉。
   现在画布 `position:fixed`，左右/底部由 JS 按**输入框卡面**实测写进 `--bga-fx-*`，
   并用 ResizeObserver 跟着卡面长高（打多行字/加附件）。粒子数按画布宽走**自适应密度**
   （无硬顶）：912px 卡面流萤 22 只、4000px 画布 88 只。
4. **消息气泡淡阴影（可调 0–1）**：气泡本体一道接触阴影 + 一层 `::before` 描边环。
   为什么要有描边环：开着 `dsh-cache-control` 的「清空气泡」时气泡 `background:transparent`，
   透明盒子上直接画 box-shadow 看不见。**不要**改成 `filter:drop-shadow` —— 那是文字阴影。
5. **卡面模糊 0–2px 每 0.1 一档**（21 档），2px 之后保持原来的粗档 3/4/6/8/12/16/24。
6. **设置面板可读底座**：设置面板（`[role="dialog"].wCInkW_panel` 及其 `::before`，底图会透出来）
   单独垫近乎不透明的一层。
7. **标签体系（v1.16.4）**：一张图可以挂**多个**标签。标签来自三处，按顺序叠加：
   ① 目录声明：放图目录根部的 `folders.json` → `folderTags: { "高清": ["高清","重返未来1999"] }`；
   ② 目录名本身（`"线稿风": ["!subject"]` 里的 `!subject` 表示保留这条）；
   ③ 文件名里的 `!主体` 覆盖（`某图!线稿风_高清.png` ⇒ 标签加「线稿风」，显示名去掉这段）。
   目录名是「高清」或文件名尾部带 `_高清`/`·高清`/`4K` 等标记时，再自动补一个「高清」标签。
   效果：`高清/6·1.png` = [高清, 重返未来1999]，`重返未来1999/6·1.png` = [重返未来1999]，
   搜 `6·1` 两版都出来；搜索同时匹配标签，卡片上直接显示标签角标。

> ⚠️ **别给 `theme.overrideTokens` 传自定义 token 名字**（比如 `--bga-surface-solid`）。
> 本机实测：塞未注册的 token 名会让宿主把**整层 override 判废** → 界面 token 全回默认
> （`--dsw-alias-bg-base: #fff`）、底图被不透明外壳盖住 = 「壁纸直接不显示」。
> 需要自定义颜色就**算成字面量**写进插件自己的样式表（见 `settingsSolidColor`）。

设置文件：本分支默认写 `$DSH_HOME\dsh-bg-atelier-plus\settings.json`；若那份还不存在而
原插件的 `dsh-bg-atelier\settings.json` 在，会直接沿用原插件那份（切过来不用重调底图/配色）。
`DSH_BG_ATELIER_SETTINGS_DIR` 可显式覆盖。派生图缓存（previews/posters/larges）跟着设置目录走。

## 离线自检

```powershell
node E:\deepseekagent\_tests\bga-live-check.mjs   # 33 项：设置归一化 / 画布几何+密度 / 升清 URL / 气泡规则 / 设置底座色
```

host 半（要用本机真实底图，以及一份能加载的 sharp）：

```powershell
$env:DSH_BG_ATELIER_WALLPAPERS="C:\Users\陈道云\.dsh\dsh-bg-atelier\wallpapers"
$env:DSH_BG_ATELIER_SETTINGS_DIR="$env:TEMP\bga-check"
$env:DSH_BG_ATELIER_SHARP="D:\deepseek dsh\DSH Desktop\resources\app.asar.unpacked\node_modules\sharp\dist\index.cjs"
node E:\deepseekagent\_tests\bga-host-check.mjs   # 10 项：large 档真的变小 / 小图逐字节原样 / 设置目录隔离
```

插件自带的老套件（`node tools/run-all.mjs`）也照跑，只有 `tools/test-we-client.mjs`
因为缺 `react` 依赖会红 —— 原插件目录同样红，属于既有问题。
