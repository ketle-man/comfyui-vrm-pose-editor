# 3D Pose Editor — ComfyUI Custom Node

[![Three.js](https://img.shields.io/badge/Three.js-r160-black)](https://threejs.org/)
[![three-vrm](https://img.shields.io/badge/@pixiv/three--vrm-2.1.0-ff69b4)](https://github.com/pixiv/three-vrm)
[![ComfyUI](https://img.shields.io/badge/ComfyUI-Custom%20Node-blue)](https://github.com/comfyanonymous/ComfyUI)

An interactive 3D pose editor node for ComfyUI.  
Load VRM / GLB / GLTF models directly in the browser, drag bones to pose them, and output the result to your workflow.

ComfyUI 上で動作するインタラクティブな 3D ポーズエディタノードです。  
VRM・GLB・GLTF モデルをブラウザから直接読み込み、ボーンをドラッグ操作してポーズを付け、そのままワークフローに出力できます。

![screenshot](docs/screenshot_workflow.png)

![pose library](docs/screenshot_pose_library.png)

![light library](docs/screenshot_light_library.png)

---

## English

### Features / Buttons

**Row 1** (capture / timer / camera / model)

| Button | Function |
|--------|----------|
| 📸 Capture | Send current pose as PNG to node output |
| ⏱ | Timer capture toggle — auto-captures every `timer_interval` seconds |
| RC | Reset camera |
| OT / PR | Toggle Orthographic / Perspective camera |
| VRM | Load VRM / GLB / GLTF file from local disk |
| CC | Color correction ON/OFF (sRGB + ACES Filmic) |

**Row 2** (library / lights / background)

| Button | Function |
|--------|----------|
| 📚 | Open Pose Library |
| 💡 | Open Light Editor |
| BG | Load background image from local disk |
| ✕ | Clear background image **and** background color |
| 🎨 | Scene background color picker |

**Row 3** (look-at / spring bone / pose)

| Button | Function |
|--------|----------|
| 👁 | Toggle LookAt target — when ON, drag the cyan marker in the 3D view to steer the eyes/head (no effect if the model has no LookAt data) |
| 🎐 | Toggle spring bone physics (hair, skirts, etc.) — turning OFF freezes the current sway state |
| 🌬 | Toggle a breeze wind effect on the spring bones (hair, skirts, etc.) — strength / direction / gustiness are adjusted in the Light Editor; has no effect while 🎐 is OFF |
| 🧭 | Toggle the wind source marker — when ON, drag the orange cone in the 3D view to set the wind direction (same operation as the LookAt marker); while ON, the "direction" slider in the Light Editor is disabled |
| RP | Reset pose |
| ↔ | Mirror pose (flip left ↔ right) |
| ⬇️ | Download current pose as JSON file |
| 💾 | Save current pose to `poses/` folder |
| 📂 | Load pose file (.json / .vroidpose) |

**Row 4** (file name)

Displays the name of the currently loaded VRM / GLB / GLTF file.

#### LookAt Target (👁)

When enabled, a cyan marker appears in the 3D view and the model's eyes/head automatically track its position. Drag the marker to steer the gaze. Resetting/loading a pose or mirroring re-anchors spring bones so nothing jumps unexpectedly. The marker itself is never captured in the output image.

#### Spring Bone Physics (🎐)

Toggles the sway-bone simulation (hair, skirts, etc.) defined on the VRM. Turning it OFF freezes the sway at its current state instead of resetting to rest pose. On Reset Pose / Load Pose / Mirror, the spring bone internal state is re-anchored to the new pose so it doesn't snap unnaturally right after the switch.

#### Wind Effect (🌬) and Wind Source Marker (🧭)

Adds a gentle breeze to the spring bones (hair, skirts, etc.) on top of the model's own gravity, using a sum of sine waves so the strength and direction gently drift over time instead of blowing in one fixed direction. Since three-vrm has no built-in wind API, this is implemented by overwriting each spring bone joint's `gravityDir`/`gravityPower` every frame with "the model's original gravity vector + the current wind vector" (the vendor `three-vrm` module itself is never modified). Has no effect while 🎐 Spring Bone Physics is OFF (the joint physics loop itself is paused).

- **🌬 Wind**: master ON/OFF toggle. Strength, direction, and gustiness are adjusted with the sliders in the Light Editor's "Wind" section.
- **🧭 Wind Source Marker**: when ON, an orange cone marker appears in the 3D view, using the exact same drag mechanism as the 👁 LookAt marker. The wind direction is computed as the direction from the marker toward a fixed reference point near the model, so you can steer the wind (including vertical components) just by dragging the cone. While ON, the "direction" slider in the Light Editor is disabled since the marker takes over. The marker is never captured in the output image.

#### Timer Capture (⏱)

Click **⏱** to start / stop the timer.

| State | Color | Behavior |
|-------|-------|----------|
| OFF | Grey (`#555`) | No auto-capture |
| ON — waiting | Dark red (`#7b0000`) | Auto-captures every N seconds |
| ON — firing | Bright red (`#e74c3c`) | Flashes for 300 ms on each capture |

The interval is read from the **`timer_interval`** node parameter (1 – 3600 s, default 5 s).  
While the timer is running, the **📸 Capture** button does **not** flash — only the ⏱ button changes colour.

### Installation

#### Option A: ComfyUI Manager (Recommended)

1. Open ComfyUI Manager and click **"Install Custom Nodes"**.
2. Search for `comfyui-vrm-pose-editor`.
3. Click **Install** and restart ComfyUI.

#### Option B: Manual

1. Place the `3dpose_custom_cm` folder inside `ComfyUI/custom_nodes/`.
2. Restart ComfyUI.
3. Add the **"3D Pose Editor"** node (category: `3D Pose`) from the node menu.

### Camera Controls

| Action | Result |
|--------|--------|
| Left drag | Rotate camera |
| Ctrl + Left drag | Pan |
| Right drag | Pan |
| Scroll wheel | Zoom (default) |
| Ctrl + Right drag | Zoom — only when the "Ctrl+Right drag zoom" switch is ON in the Light Editor (see below) |
| Alt + Left drag | Zoom (Node 2.0 mode) |
| Click gizmo X/Y/Z axis | Snap to that view direction |

> On some PCs the scroll wheel does not zoom (mouse/driver dependent). Open the **Light Editor (💡)** and toggle **🖱 Ctrl+Right drag zoom** in the top scene bar to switch from wheel zoom to Ctrl+Right-drag zoom.

### Bone Controls

Drag the blue control points on each bone joint.

| Action | Rotation |
|--------|----------|
| Left / Right drag | Y-axis |
| Up / Down drag | X-axis |
| Alt + Up / Down drag | Z-axis |

### Loading Models

Click the **VRM** button to select a local `.vrm` / `.glb` / `.gltf` file.  
The model is automatically scaled and centred.

- **VRM**: bones detected via `@pixiv/three-vrm` HumanBone.
- **GLB / GLTF**: works with any skeleton-based model.

### Default Model

Place one of the following files in the `js/` folder to auto-load on startup:

| Filename | Format |
|----------|--------|
| `model.glb` | GLB |
| `model.vrm` | VRM |
| `model.gltf` | GLTF |

Priority: `model.glb` → `model.vrm` → `model.gltf`. If none exist, the editor starts without a model.

### Pose Library (📚)

Click the **📚** button on any node to open the Pose Library.

- Pose files (`.json` / `.vroidpose`) stored in the `poses/` folder are displayed as thumbnails.
- **Subdirectory filtering**: create subfolders inside `poses/` to organise poses by category; select a folder from the dropdown to filter.
- **Click** a thumbnail to apply the pose immediately.
- **Right-click** for more options:
  - ↔️ Mirror & Apply
  - ⭐ Add / Remove Favorites
  - 📝 Edit Memo
  - ✏️ Rename File
  - 🖼 Regenerate Thumbnail (Front / Back)
- **💾 Save**: saves the current editor pose to the `poses/` folder as `p_HHMMSS.json`.
- Thumbnails are auto-generated using the loaded VRM model and cached server-side.

### Pose Save / Load

| Button | Action |
|--------|--------|
| ⬇️ | Download pose as `pose.json` (browser download) |
| 💾 | Save pose to `poses/p_HHMMSS.json` on the server |
| 📂 | Load pose file (or drop onto canvas) |

Supported formats:

| Format | Description |
|--------|-------------|
| `.json` (own format) | Saved by ⬇️ or 💾 |
| `.vroidpose` | VRoid Studio pose file (body / arms / legs; finger presets not supported) |

#### VRM0 / VRM1 Compatibility

Pose JSON is saved in **version 2** format (quaternion + `vrmVersion` tag).  
Cross-version conversion (VRM0 ↔ VRM1) is applied automatically on load.  
Legacy version 1 (Euler angles) files are still supported.

### Mirror Pose (↔)

Click **↔** on the node (or right-click → **↔️ Mirror & Apply** in the Pose Library) to flip the current pose left ↔ right.  
Left/Right bone pairs are swapped and quaternions are YZ-flipped `(qx, -qy, -qz, qw)`.

### Light Editor (💡)

Click **💡** on any node to open the Light Editor panel.

- **3D preview** with live bone / camera / light-helper interaction (actual WebGL canvas, not a copy).
- **Multiple lights**: add any number of lights. Types: ☀ Sun (Directional), 💡 Point, 🔦 Spot, ▭ Box (RectArea), 🌐 Ambient.
- **Per-light settings**: color, intensity, position XYZ, target XYZ (Directional / Spot), angle & penumbra (Spot), distance & decay (Point / Spot), shadow (Directional only).
- **Drag the yellow sphere** in the preview to reposition a light in 3D.
- **Shadow note**: Only DirectionalLight supports `castShadow`. SpotLight / PointLight shadows are incompatible with the VRM MToon shader.
- **Shadow quality**: None / Soft PCF / Hard selector.
- **🖱 Ctrl+Right drag zoom**: Toggle in the top scene bar. OFF (default) = scroll wheel zoom. ON = disables wheel zoom and lets you zoom by Ctrl+Right-dragging on empty space — useful when the scroll wheel doesn't zoom on some PCs/mice. This setting also applies to the main preview canvas outside the Light Editor.
- **🌬 Wind**: master ON/OFF toggle plus three sliders — **strength** (0–5), **direction** (0–360°, disabled while the 🧭 wind source marker is ON), and **gustiness** (0–1, how much the strength/direction drift over time; 0 = steady wind).
- **📚 Library**: Save and recall complete light presets (all lights + Ground / BG Wall / Shadow settings).

#### Light Library (📚)

Click **📚 Library** in the Light Editor header to open the Library panel.

| Action | Description |
|--------|-------------|
| 💾 Save Current | Save all current settings as a named preset |
| Click a preset card | Apply saved settings immediately |
| Right-click a card | Rename or delete the preset |
| Search field | Filter presets by name |
| ↺ Reload | Refresh the preset list from the server |

Presets are stored server-side in `.light_library/` inside the node folder.  
They persist across browser restarts and are available on any machine sharing the same ComfyUI server.

> **Note**: Texture images are not saved in presets (binary data is excluded).  
> All numeric settings (color, intensity, positions, Ground/Wall/Shadow values) are saved and restored.

#### Ground & Background Wall

| Control | Function |
|---------|----------|
| 🟫 Ground ON/OFF | Toggle ground plane (receives shadows) |
| Y slider | Ground height |
| 🖼 BG Wall ON/OFF | Toggle background wall (receives shadows) |
| Z slider | Wall depth |
| 🎨 Color picker | Surface color |
| 📁 Tex | Load image texture (tiled) |
| Tile | Texture repeat count |
| 🕶 SC | Shadow Catcher — surface becomes transparent, shows shadows only |
| 影濃度 / Opacity | Shadow darkness (0.01 – 1.0) |



### Aspect Ratio Frame

When `output_size_mode` is **Custom**, a letterbox overlay is drawn in real time to show the output crop area.  
**Capture** outputs only the framed region — no stretching.

### Shape Keys

Click the **Shape Keys** header at the bottom of the node to expand the panel.  
Adjust morphs / expressions with sliders (0.0 – 1.0) in real time.

### Color Correction (CC)

Toggle sRGB color space + ACES Filmic tone mapping.  
Enable if VRoid Studio / Blender models appear too dark.

---

## 日本語

### 機能・ボタン一覧

**1行目**（キャプチャ・タイマー・カメラ・モデル）

| ボタン | 機能 |
|--------|------|
| 📸 Capture | 現在のポーズを PNG としてノード出力に送信 |
| ⏱ | タイマーキャプチャのトグル（`timer_interval` 秒ごとに自動キャプチャ） |
| RC | カメラをリセット |
| OT / PR | Orthographic / Perspective カメラを切り替え |
| VRM | VRM / GLB / GLTF ファイルをローカルから読み込む |
| CC | カラー補正 ON/OFF（sRGB + ACES Filmic） |

**2行目**（ライブラリ・ライト・背景）

| ボタン | 機能 |
|--------|------|
| 📚 | ポーズライブラリを開く |
| 💡 | ライトエディタを開く |
| BG | 背景画像をローカルから読み込む |
| ✕ | 背景画像**および**背景色をクリア |
| 🎨 | シーン背景色ピッカー |

**3行目**（視線・揺れ・ポーズ）

| ボタン | 機能 |
|--------|------|
| 👁 | 視線ターゲットの ON/OFF。ON にすると 3D ビュー内のシアン色マーカーをドラッグして目・頭の向きを誘導できる（モデルに LookAt 情報が無い場合は効果なし） |
| 🎐 | 揺れ物理（髪・スカート等）の ON/OFF。OFF にすると現在の揺れ具合のまま固定される |
| 🌬 | 揺れボーン（髪・スカート等）にそよ風エフェクトを加える ON/OFF。強さ・向き・そよぎはライトエディタで調整。🎐 が OFF の間は効果なし |
| 🧭 | 風の発生源マーカーの ON/OFF。ON にすると 3D ビュー内のオレンジ色のコーンをドラッグして風向きを指定できる（視線マーカーと同じ操作方法）。ON の間、ライトエディタの「向き」スライダーは無効化される |
| RP | ポーズをリセット |
| ↔ | ポーズを左右反転 |
| ⬇️ | 現在のポーズを JSON ファイルとしてダウンロード |
| 💾 | 現在のポーズを `poses/` フォルダに保存 |
| 📂 | ポーズファイルを読み込む（.json / .vroidpose） |

**4行目**（ファイル名）

現在読み込まれている VRM / GLB / GLTF のファイル名を表示。

#### 視線ターゲット（👁）

ON にすると 3D ビュー内にシアン色のマーカーが表示され、モデルの目・頭がマーカーの方向を自動的に追従します。マーカーをドラッグして視線の向きを調整できます。ポーズリセット・ポーズ読込・ミラー実行時は揺れボーンの内部状態を新しいポーズに合わせて再アンカーするため、切替直後に不自然に跳ねることはありません。マーカー自体は出力画像には写り込みません。

#### 揺れ物理（🎐）

VRM に定義された揺れボーン（髪・スカート等）の物理シミュレーションの ON/OFF を切り替えます。OFF にすると、リセット姿勢に戻るのではなく現在の揺れ具合のまま固定されます。ポーズリセット・ポーズ読込・ミラー実行の直後は揺れボーンの内部状態を新しいポーズに再アンカーするため、切替直後に不自然に跳ねることはありません。

#### 風エフェクト（🌬）と発生源マーカー（🧭）

揺れボーン（髪・スカート等）に、モデル本来の重力に加えてそよ風を吹かせる機能です。複数のsin波を合成することで、風の強さ・向きが一定方向に吹き続けるのではなく時間とともに緩やかに揺らぐようにしています。three-vrmには風専用のAPIが存在しないため、各揺れボーンの`gravityDir`/`gravityPower`を毎フレーム「モデル本来の重力ベクトル＋現在の風ベクトル」で上書きすることで実現しています（vendorの`three-vrm`本体は無改造）。🎐揺れ物理がOFFの間はジョイント物理演算自体が停止するため、風の効果もありません。

- **🌬 風**: 全体のON/OFFトグル。強さ・向き・そよぎは、ライトエディタの「Wind」セクション内のスライダーで調整します。
- **🧭 発生源マーカー**: ONにすると3Dビュー内にオレンジ色のコーンマーカーが表示されます。操作方法は👁視線マーカーと全く同じドラッグ方式です。風向きは「マーカー位置からモデル付近の固定基準点への方向」として計算されるため、コーンをドラッグするだけで（上下方向を含む）風向きを自由に指定できます。ONの間はマーカーが向きを決定するため、ライトエディタの「向き」スライダーは無効化されます。マーカー自体は出力画像には写り込みません。

#### タイマーキャプチャ（⏱）

**⏱** ボタンをクリックしてタイマーを開始 / 停止します。

| 状態 | 色 | 動作 |
|------|----|----|
| OFF | グレー（`#555`） | 自動キャプチャなし |
| ON — 待機中 | 暗い赤（`#7b0000`） | N 秒ごとに自動キャプチャ |
| ON — 実行瞬間 | 明るい赤（`#e74c3c`） | 300ms 点灯して暗い赤に戻る |

間隔は **`timer_interval`** ノードパラメータ（1〜3600 秒、デフォルト 5 秒）で指定します。  
タイマー動作中は **📸 Capture** ボタンは変化せず、⏱ ボタンのみ色が変わります。

### インストール

#### Option A: ComfyUI Manager（推奨）

1. ComfyUI Manager を開き、**「カスタムノードをインストール」** をクリック。
2. `comfyui-vrm-pose-editor` を検索。
3. **Install** をクリックして ComfyUI を再起動。

#### Option B: 手動インストール

1. `3dpose_custom_cm` フォルダを `ComfyUI/custom_nodes/` に配置。
2. ComfyUI を再起動。
3. ノードメニューから **"3D Pose Editor"**（カテゴリ: `3D Pose`）を追加。

### カメラ操作

| 操作 | 動作 |
|------|------|
| 左ドラッグ | カメラ回転 |
| Ctrl + 左ドラッグ | パン（平行移動） |
| 右ドラッグ | パン（平行移動） |
| ホイール | ズーム（既定） |
| Ctrl + 右ドラッグ | ズーム — ライトエディタの「Ctrl+右ドラッグでズーム」スイッチが ON のときのみ有効（後述） |
| Alt + 左ドラッグ | ズーム（Node2.0 モード時） |
| ビューギズモ軸クリック | その方向へスナップ |

> PC 環境によってはマウスホイールでズームできない場合があります（マウス・ドライバ依存）。**ライトエディタ（💡）** を開き、上部の Scene バーにある **🖱 Ctrl+右ドラッグでズーム** をトグルすると、ホイールズームから Ctrl+右ドラッグズームに切り替えられます。

### ボーン操作

ボーン上の青い点（コントロールポイント）をドラッグします。

| 操作 | 動作 |
|------|------|
| 左右ドラッグ | Y 軸回転 |
| 上下ドラッグ | X 軸回転 |
| Alt + 上下ドラッグ | Z 軸回転 |

### ポーズライブラリ（📚）

ノード上の **📚** ボタンをクリックするとポーズライブラリが開きます。

- `poses/` フォルダ内のポーズファイル（`.json` / `.vroidpose`）をサムネイル一覧で表示。
- **サブディレクトリフィルター**: `poses/` 内にサブフォルダを作成してポーズをカテゴリ分けし、ドロップダウンで絞り込み。
- サムネイルを**クリック**するとポーズを即時適用。
- **右クリック**でメニュー:
  - ↔️ Mirror & Apply（左右反転して適用）
  - ⭐ お気に入り追加 / 解除
  - 📝 メモ編集
  - ✏️ ファイル名変更
  - 🖼 サムネイル再生成（正面 / 背面）
- **💾 Save**: 現在のエディタのポーズを `poses/p_HHMMSS.json` として保存。
- サムネイルは読み込み済み VRM を使ってオフスクリーンで自動生成・キャッシュ。

### ライトエディタ（💡）

ノードの **💡** ボタンをクリックするとライトエディタが開きます。

- **3D プレビュー**: 実際の WebGL canvas を埋め込み（コピーではない）。ボーン操作・カメラ操作・ライトヘルパードラッグがプレビュー内でネイティブに動作。
- **複数ライト**: 任意の数を追加可能。タイプ: ☀ Sun (Directional) / 💡 Point / 🔦 Spot / ▭ Box (RectArea) / 🌐 Ambient。
- **ライト設定**: 色・強度・位置 XYZ・ターゲット XYZ（Directional/Spot）・角度＆ペナンブラ（Spot）・距離＆減衰（Point/Spot）・シャドウ（Directional のみ）。
- **黄色球体をドラッグ**してプレビュー内でライトを 3D 移動。
- **シャドウ注意**: DirectionalLight のみ `castShadow` 対応。SpotLight/PointLight のシャドウは VRM MToon シェーダーと非互換。
- **🖱 Ctrl+右ドラッグでズーム**: 上部の Scene バーにあるトグルスイッチ。OFF（既定）＝マウスホイールでズーム。ON＝ホイールズームを無効化し、何もない場所での Ctrl+右ドラッグでズームできるようにする。マウスやドライバの相性でホイールズームが効かない環境向け。この設定はライトエディタ外のメインプレビューキャンバスにも適用される。
- **🌬 Wind**: 全体のON/OFFトグルと、3つのスライダー — **強さ**（0〜5）・**向き**（0〜360°、🧭発生源マーカーがONの間は無効化）・**そよぎ**（0〜1、強さ・向きが時間とともにどれだけ揺らぐか。0＝一定の風）。
- **📚 Library**: ライト設定プリセット（全ライト ＋ Ground / BG Wall / Shadow 設定）の保存・呼び出し。

#### ライトライブラリ（📚）

ライトエディタのヘッダーにある **📚 Library** ボタンをクリックするとライブラリパネルが開きます。

| 操作 | 内容 |
|------|------|
| 💾 Save Current | 現在の全設定をプリセット名を付けて保存 |
| プリセットカードをクリック | 保存済みの設定を即時適用 |
| プリセットカードを右クリック | 名前変更・削除 |
| 検索フィールド | 名前で絞り込み |
| ↺ リロード | サーバーから一覧を再読み込み |

プリセットはサーバー側の `.light_library/` フォルダに保存されます（ノードフォルダ内）。  
ブラウザを再起動しても残り、同じ ComfyUI サーバーを使う別のマシンからも利用できます。

> **注意**: テクスチャ画像はプリセットに保存されません。  
> 色・強度・位置・Ground/Wall/Shadow のすべての数値設定は保存・復元されます。

#### 地面・背景壁

| コントロール | 機能 |
|------------|------|
| 🟫 Ground ON/OFF | 地面（影を受ける）の表示切替 |
| Y スライダー | 地面の高さ |
| 🖼 BG Wall ON/OFF | 背景壁（影を受ける）の表示切替 |
| Z スライダー | 壁の奥行き |
| 🎨 カラーピッカー | 面の色 |
| 📁 Tex | テクスチャ画像読み込み（タイル表示） |
| Tile | テクスチャの繰り返し数 |
| 🕶 SC | シャドウキャッチャー — 面を透明にして影のみ表示 |
| 影濃度 | 影の暗さ（0.01 〜 1.0） |

### ポーズ左右反転（↔）

ノードの **↔** ボタン、またはポーズライブラリの右クリックメニュー **↔️ Mirror & Apply** で現在のポーズを左右反転します。  
Left/Right ボーンペアを入れ替え、クォータニオンを YZ 反転 `(qx, -qy, -qz, qw)` して適用します。

### デフォルトモデルの設定

`js/` フォルダに以下のいずれかを配置すると起動時に自動ロードされます。

| ファイル名 | 形式 |
|-----------|------|
| `model.glb` | GLB |
| `model.vrm` | VRM |
| `model.gltf` | GLTF |

優先順位: `model.glb` → `model.vrm` → `model.gltf`

---

## Node I/O

| Item | Type | Description |
|------|------|-------------|
| `background_image` | IMAGE (optional) | Background composited with the captured pose on the Python side |
| `output_size_mode` | Standard / Background / Custom | Output resolution mode |
| `custom_width` / `custom_height` | INT | Output size in Custom mode |
| `timer_interval` | INT | Timer capture interval in seconds (1 – 3600, default 5) |
| **output: image** | IMAGE | Captured pose image (Torch tensor) |

---

## Technical Specs

- **Frontend**: JavaScript + [Three.js r160](https://threejs.org/) + [@pixiv/three-vrm 2.1.0](https://github.com/pixiv/three-vrm) (bundled locally)
- **Backend**: Python — Base64 PNG → PIL → Torch Tensor
- **Pose Library API**: aiohttp routes registered via `@PromptServer.instance.routes`
- **Light Library API**: `GET/POST /light_library/*` — presets stored in `.light_library/` as `l_HHMMSS.json`
- **Capture**: letterbox-cropped to output aspect ratio (no stretching)
- **Camera**: Perspective (FOV 45°) / Orthographic toggle
- **Pose JSON**: version 2 (quaternion + `vrmVersion` tag, VRM0/VRM1 cross-compatible)
- **VRM0 quaternion**: Unity left-hand → Three.js right-hand `(x, y, -z, -w)`
- **VRM1 quaternion**: VRM0 conversion + VRM0→VRM1 `(x, -y, z, -w)`
- **Pose mirror**: Left↔Right bone swap + YZ-flip `(qx, -qy, -qz, qw)`
- **Lights**: managed multi-light system (Directional / Point / Spot / RectArea / Ambient); shadow restricted to DirectionalLight (VRM MToon constraint)
- **Ground / BG Wall**: `MeshStandardMaterial` (opaque) or `ShadowMaterial` (shadow catcher); color, texture, tile, height/depth adjustable
- **Background color**: `scene.background = THREE.Color` via color picker; transparent by default
- **Zoom mode**: wheel zoom (default) or Ctrl+Right-drag zoom, toggled from the Light Editor scene bar (`editor.getZoomMode()` / `setZoomMode()`). Persisted in `localStorage` (`vrmPoseEditor_zoomMode`), shared across all ComfyUI nodes and pages on the same origin
- **Light presets**: full scene snapshot (all lights + Ground/Wall/Shadow values); texture images excluded; stored server-side as JSON files
- **Core module**: `js/pose_editor_core.js` exports `initPoseEditor3D()` with zero ComfyUI dependency, so it can be imported directly from external pages (e.g. `/extensions/comfyui-vrm-pose-editor/pose_editor_core.js`) alongside `light_editor.js` / `pose_library.js`
- **Wind effect**: implemented entirely in `pose_editor_core.js` by overwriting each `VRMSpringBoneJoint`'s `settings.gravityDir`/`gravityPower` every frame (`_applyWindToSpringBones()`), computed as "the joint's original gravity vector (captured on model load) + a wind vector"; the vendor `three-vrm` module is unmodified. The wind vector is a sum of sine waves at several periods so strength and direction gust gently over time (`_computeWindVector()` for the angle-slider mode, `_computeWindVectorFromSource()` for the marker mode — the latter builds a pseudo-up axis orthogonal to the marker→reference-point direction and rotates the gust around it, so it generalizes cleanly to any 3D direction). Has no effect while spring bone physics is OFF, since `VRMSpringBoneJoint.update()` returns immediately when `delta <= 0`.
- **Wind source marker**: a cone mesh (`windSourceHelperMesh`) added to the scene and hidden by default, reusing the exact same pointerdown/move/up drag-on-a-camera-facing-plane logic as the 👁 LookAt marker. It is excluded from `capture()` output the same way the LookAt marker is.

---

## License

MIT License
