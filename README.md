# QQPet

QQ 宠物跨平台复刻（Windows / macOS / Linux / Android / HarmonyOS / iOS），基于 Arctic Penguin T800 逆向重建。Flash 内容由 [Ruffle](https://ruffle.rs) 播放。

> **版权声明**：QQ 宠物的美术资源与 SWF 版权归腾讯所有；旅行照片素材版权归《旅行青蛙·中国之旅》所有。本项目仅供学习交流，请勿用于商业用途。

## 截图

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/pet.png" alt="桌面宠物与右键菜单"><br>桌面宠物与右键菜单</td>
    <td width="50%"><img src="docs/screenshots/shop.png" alt="商城与背包"><br>商城与背包</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/petinfo.png" alt="宠物资料"><br>宠物资料</td>
    <td><img src="docs/screenshots/signin.png" alt="图鉴与签到"><br>图鉴与签到</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/task.png" alt="今日任务"><br>今日任务</td>
    <td><img src="docs/screenshots/travel.png" alt="全国旅游"><br>全国旅游</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/setup.png" alt="系统设置"><br>系统设置</td>
    <td></td>
  </tr>
</table>

## 功能

- **养成**：选蛋领养、成长与升级、饥饿/清洁/心情/健康、生病就医、死亡与复活、重生（可换性别）。
- **日常**：打工、上学（含升学考试）、全国旅游（奇遇、纪念品、旅行相簿明信片），关闭应用期间的进度照常计时。
- **物品**：商城与购物车、背包、食物/清洁/药品/玩具、限时物品、粉钻与甜蜜情侣。
- **任务与邮件**：今日任务（按宠物需求和节假日生成）、逗逗我、学习打工、旅游任务；签到与图鉴；节日、生日、旅行明信片邮件。
- **活动**：池塘（养鱼）、农场（QQFarm，金币即元宝）、密室探险、6 类 101 个小游戏（独立窗口，按游戏时长奖励）。
- **AI（可选）**：接入任意 OpenAI 兼容接口，宠物闲聊、改写台词、点评或翻译剪贴板文字。
- **其他**：天气播报、节日问候、免打扰、透明度、开机自启、全屏应用（看视频、玩游戏）在前台时自动隐藏宠物、高清画质（重绘的 @2x 素材，适配高分屏，重启后生效）、存档导入导出（兼容原版 `config.json`，首次启动的选蛋页也可直接导入）。

存档位于 `userData/save.json`，导入时旧存档备份为 `save.json.bak`。

桌面版支持将宠物拖到其他显示器（包括主屏左侧或上方、不同缩放比例的屏幕），重启后回到上次所在的显示器；该显示器断开时回到主屏幕。

### iOS

最低目标为 iOS 14.0。安装需使用保留所需权限的越狱 App 安装器或 TrollStore，后者的系统兼容范围以其上游说明为准。全局 HUD 依赖系统私有接口和所需权限，普通开发者签名不能替代这些权限。打开管理 App，点击「开始桌宠」，返回主屏幕后桌宠继续显示在其他应用上方。打开管理界面会暂时隐藏桌宠；「宠物菜单」「宠物状态」可显示相应界面，「返回管理」用于回到管理操作。

复用完整养成、界面和 SWF 内容，增加原生触摸分区、游戏展示和系统文件选择器导入导出。HUD 输入框通过前台管理器的原生编辑框提交文字。剪贴板文本由用户主动发送；后台剪贴板监听及前台应用观察暂不提供，因而也不提供其他 App 全屏时自动隐藏，设置会说明平台能力限制。此版本不安装 daemon，也不提供开机自启；完整重启后需手动开始。

本地使用 Node 22.12 或以上版本、公开 iPhoneOS SDK 和本地 `ldid`（也支持 ad-hoc `codesign`）。资源准备是独立步骤，普通构建使用本地文件：

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts
npm run prepare:ios-assets
npm run ios
```

产物为 `out/ios-native/QQPetIOS.ipa`。安装器需保留 IPA 内的 entitlement。共用渲染代码以 Safari 14.0 能力为底线，构建会降级 Ruffle 回退 WASM 的符号扩展指令，并验证结果只依赖基础特性；Electron 外壳保留原有最低 macOS 版本要求。构建选项、存档路径、后台生命周期和平台限制见 [iOS 使用说明](ios/README.md)。

### Android

宠物以悬浮窗形式显示在桌面和其他应用上方，功能与桌面版一致，另有以下适配：

- 首次打开需允许「显示在其他应用的上层」和通知权限；通知栏常驻的通知代替桌面版的托盘图标。
- 宽面板在竖屏手机上自动旋转并铺满屏幕；横竖屏切换后宠物保持在屏幕内。
- 小游戏和密室探险全屏横屏运行，并显示可改键的虚拟手柄。
- 系统不允许后台读取剪贴板：在其他应用里选中文字后，从选择菜单或分享面板选「QQ宠物」，交给宠物点评或翻译。

### HarmonyOS

纯血鸿蒙（HarmonyOS NEXT / 5 及以上）不能装 Android APK。宠物同样以悬浮窗显示，JS 桥和 Android 是同一份 `QQPetNative` 契约，原生壳在 `harmony/`，渲染层不改。

- 首次打开需允许「显示在其他应用的上层」和通知；通知栏通知代替桌面版的托盘图标。
- 小游戏和密室探险全屏横屏运行（`GameAbility`）。
- 系统不允许后台读剪贴板：在其他应用里分享文字给「QQ宠物」，交给宠物点评或翻译。
- 没有开机自启：当前 SDK 没有可用的开机广播扩展。
- 窗口按页面可见内容裁剪；拖动时会铺满屏幕，避免跟手错位。

本地打包：`npm run harmony`，需要本机 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)（`harmony/hvigorw` 默认使用 `/Applications/DevEco-Studio.app`，可用 `DEVECO_SDK_HOME` / `NODE_HOME` / `JAVA_HOME` 覆盖）。产物在 `harmony/entry/build/default/outputs/default/`。

GitHub Actions 打 `v*` 标签时产出未签名 HAP 并放进 Release。和桌面包一样没有商店签名；用 hdc 装到模拟器或已开启调试的真机。上架或普通真机日常安装要在 DevEco 里配签名，目前仓库没有这份材料。

## 下载安装

从 [Releases](https://github.com/AnkioTomas/qqpet/releases/latest) 下载对应平台的安装包：

| 平台 | 文件 |
|---|---|
| Windows | `QQPet.Setup.<版本>.exe` |
| macOS（Apple 芯片） | `QQPet-<版本>-arm64.dmg` |
| macOS（Intel） | `QQPet-<版本>.dmg` |
| Linux | `QQPet-<版本>.AppImage` 或 `qqpet_<版本>_amd64.deb` |
| Android（11 及以上） | `QQPet-<版本>.apk` |
| HarmonyOS（5 及以上） | `QQPet-<版本>.hap` |
| iOS（需 TrollStore 或越狱） | `QQPet-<版本>-ios.ipa` |

桌面安装包**没有代码签名**，系统会拦截首次运行。各平台安装方式：

- **Windows**：SmartScreen 提示「Windows 已保护你的电脑」时，点「更多信息」→「仍要运行」。
- **macOS**：把 QQPet 拖进「应用程序」后，若提示「已损坏，无法打开」或「无法验证开发者」，在终端执行一次：

  ```bash
  xattr -cr /Applications/QQPet.app
  ```

  也可以先打开一次，再到「系统设置 → 隐私与安全性」底部点「仍要打开」。
- **Linux**：AppImage 需要可执行权限，`chmod +x QQPet-*.AppImage` 后运行；Ubuntu 22.04 起若报缺少 FUSE，安装 `libfuse2`（24.04 为 `libfuse2t64`）。deb 包用 `sudo apt install ./qqpet_*_amd64.deb` 安装。
- **Android**：在浏览器或文件管理器中打开 APK，按提示允许「安装未知应用」。
- **HarmonyOS**：下载 HAP 后用 hdc 安装（需开发者模式）：`hdc install QQPet-*.hap`。未签名，不能走应用市场那套安装。
- **iOS**：通过 TrollStore 或保留所需权限的越狱 App 安装器安装 IPA；安装器需保留 IPA 内的 entitlement。权限与使用方式见 [iOS 使用说明](ios/README.md)。

## 征集素材

社区里能找到的 QQ 宠物原版资料很少，大量游戏画面和素材已经缺失，复刻时只能靠猜。如果你手上有下面这些东西，欢迎提供：

- **老版本客户端**：QQ 宠物的安装包或安装目录，以及老版本 QQ 留下的宠物缓存目录（里面的 SWF、图片、音效、配置文件都有用）。
- **游戏画面**：当年的截图、录屏、视频，尤其是打工、上学、旅游、小游戏、商城、节日活动等界面。
- **其他资料**：物品与宠物数据、台词文本、活动说明，或者你记得的玩法细节。

### 目前确认缺少的素材

对照 issue #25 提供的素材包逐一比对后，下面这些仍然没有找到：

| 类别 | 缺少的内容 |
|---|---|
| 社区场景 | 瓦里步行街、企鹅镇整张场景贴图；风语广场最下面一行贴图；粉钻雪山约一半装饰物；新版夏帕海岸、新版粉钻雪山；所有场景的小地图和大地图图片 |
| 社区老版本美术 | `bg_V35`、`V41`、`V49`、`V66`、`V108` 等旧版场景目录目前都是空的 |
| 女宠（MM）动作 | 新版待机、行走变体、拖拽姿势、走路停下后的张望、躲藏、趴下与起身等动作，目前只有男宠（GG）有 |
| 成年宠物 | 向左躲藏（`hide_left`）动作，目前只有向右 |
| 宠物互动 | 已从 QPet2 补齐 23 组双宠互动（`interact2`）；仍缺以蛋为主人的组合、`112_102`/`113_102` 等未收录的组合，部分组合缺拔河或喂食动画，以及当年互动时的台词文本 |
| 社区小游戏 | 生日屋的「生日蛋糕」（`qq_srdg`）、「机械宝宝」等原版社区小游戏的 SWF 文件 |
| 题库 | 带四个选项和科目分类的原版考试题库（现有的只有"问题=答案"格式） |

社区场景的贴图原本是客户端运行时从服务器下载的，安装包里没有。如果你有当年的 QQ 宠物或 QQ 缓存目录（尤其是 `petsoc` 相关文件），会很有帮助。

提交方式：在 [Issues](https://github.com/AnkioTomas/qqpet/issues) 发帖说明你有什么，文件较大可附网盘链接。提交的素材版权仍归腾讯所有，只用于本项目的学习复刻。

## 开发

```bash
git lfs install && git lfs pull   # resources/pet 由 Git LFS 管理
npm ci
npm run dev
```

## 构建

```bash
npm run dist      # 类型检查 + 构建 + 打包当前平台安装包到 dist/
npm run android   # Android debug APK
npm run harmony   # HarmonyOS debug HAP（需要本机 DevEco Studio）
npm run ios       # iOS IPA（资源、SDK 和签名工具见 iOS 说明）
```

推送 `v*` 标签时由 GitHub Actions 打出三平台安装包、Android APK、Harmony HAP 和 iOS IPA 并发布 Release。iOS 及共用代码的 pull request 还会生成可下载的 IPA。iOS CI 在 Ubuntu 上使用固定版本的 LLVM、SDK 和 `ldid`，并打包完整资源。

Android 版本地调试用 `npm run android`（debug 包，输出到 `android/app/build/outputs/apk/debug/`），需要 Android SDK 和 JDK 17（Gradle 8 不支持更新的 JDK，可用 `JAVA_HOME` 指定）。CI 打的 release 包需要在仓库 Secrets 中配置签名密钥：

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64（`base64 -i release.jks`） |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

每次发布都必须用同一个 keystore，否则已安装的用户无法覆盖升级。

## 改过的 SWF

以下文件用 [JPEXS FFDec](https://github.com/jindrapetrik/jpexs-decompiler) 打过补丁，重新导入资源时不要覆盖：

| 文件 | 改动 |
|---|---|
| `resources/pet/mstx/qq_mstx.swf` | 隐藏需要联网的「兑换礼包」「魔法爱情石」按钮 |
| `resources/pet/qqfarm/Farm.swf` | 允许在 `file://` 之外启动；「金币」改为「元宝」；商店可买的种子排前、其余置灰，购买后弹出提示；商店、仓库的弹出动画改为缩放比例，不再被异步加载的图片压窄；不绘制房屋、篱笆、狗窝 |
| `resources/pet/qqfarm/props.swf` | 素材中的「金币」文字改为「元宝」 |
| `resources/pet/smallGame/{100ceng,ball,paopao2}/` 下读屏幕尺寸的 26 个 SWF | `Capabilities.screenResolutionX/Y` 改为 `ExternalInterface.call("API.GetScreenWidth/Height")`（Ruffle 返回的是播放器自身尺寸） |

## 目录

| 路径 | 说明 |
|---|---|
| `src/main` | 主进程：窗口、托盘、`app://` 协议、存档、AI 与天气请求 |
| `src/preload` | `window.qqpet` 接口 |
| `src/renderer` | 界面（原生 TypeScript），`pet/` 为养成逻辑，`ui/` 为各窗口，`swf/` 为 Ruffle 封装 |
| `src/shared` | 主进程与渲染层共享的 IPC 与存档类型 |
| `src/android` | Android 版的 `window.qqpet` 实现，经 WebView 接口调用原生层 |
| `android/` | Android 原生工程：悬浮窗服务、游戏页、文件选择、文字分享入口、开机自启 |
| `src/harmony` | HarmonyOS 版的 `window.qqpet` 实现，经 ArkWeb 接口调用原生层 |
| `harmony/` | HarmonyOS 原生工程：浮动窗、游戏页、存档选择、分享入口 |
| `resources/pet` | 原版资源，`npm run import-assets -- <app.asar>` 可重新导入 |
| `tools/` | 反混淆脚本、原版 CSS 移植脚本、CDP 调试脚本 |

## 许可证

本项目代码以 [GPL-3.0](LICENSE) 发布。该许可证不覆盖 `resources/pet` 下的原版美术资源、SWF 与旅行照片，它们的版权归各自所有者，见文首版权声明。

## 友情链接

本项目认可 [LINUX DO](https://linux.do) 社区。
