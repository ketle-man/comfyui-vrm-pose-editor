# 3D Pose Editor — ComfyUI Custom Node

ComfyUI 上で動作するインタラクティブな 3D ポーズエディタノードです。
VRM・GLB・GLTF モデルをブラウザから直接読み込み、ボーンをドラッグ操作してポーズを付け、そのままワークフローに出力できます。

![Three.js](https://img.shields.io/badge/Three.js-r160-black)
![three-vrm](https://img.shields.io/badge/@pixiv/three--vrm-2.1.0-ff69b4)
![ComfyUI](https://img.shields.io/badge/ComfyUI-Custom%20Node-blue)

---

## 機能一覧

| ボタン | 機能 |
|---|---|
| 📸 Capture | 現在のポーズを PNG としてノード出力に送信 |
| RP | ポーズをリセット |
| RC | カメラをリセット |
| VRM | VRM / GLB / GLTF ファイルをローカルから読み込む |
| CC | カラー補正 ON/OFF（sRGB + ACES Filmic） |
| BG | 背景画像をローカルから読み込む |
| ✕ | 背景画像をクリア |
| 💾 | 現在のポーズを JSON ファイルとして保存 |
| 📂 | ポーズファイルを読み込む（.json / .vroidpose） |

---

## インストール

### Option A: ComfyUI Manager（推奨）

1. ComfyUI Manager を開き、**「カスタムノードを管理」** をクリックします。
2. 検索欄に `comfyui-vrm-pose-editor` と入力します。
3. **Install** をクリックして ComfyUI を再起動します。

### Option B: 手動インストール

1. `3dpose_custom_cm` フォルダを `ComfyUI/custom_nodes/` 以下に配置します。
2. ComfyUI を再起動します。
3. ノードメニューで **"3D Pose Editor"**（カテゴリ: `3D Pose`）を追加します。

---

## 使い方

### カメラ操作

| 操作 | 動作 |
|---|---|
| 左ドラッグ | カメラ回転 |
| Ctrl + 左ドラッグ | パン（平行移動） |
| 右ドラッグ | パン（平行移動） |
| ホイール | ズーム |
| Alt + 左ドラッグ | ズーム（Node2.0モード時） |
| ビューギズモのX/Y/Z軸クリック | その軸方向からのビューにスナップ |

### ボーン操作

ボーン上の青い点（コントロールポイント）をドラッグします。

| 操作 | 動作 |
|---|---|
| 左右ドラッグ | Y 軸回転 |
| 上下ドラッグ | X 軸回転 |
| Alt + 上下ドラッグ | Z 軸回転 |

### モデルの読み込み

**VRM** ボタンをクリックしてローカルの `.vrm` / `.glb` / `.gltf` ファイルを選択します。
モデルは自動でスケーリング・センタリングされます。

- **VRM ファイル**: `@pixiv/three-vrm` の HumanBone を使用してボーンを認識します。
- **GLB / GLTF ファイル**: 骨格（Bone）ベースのモデルであればそのまま動作します。

### デフォルトモデルの設定

ノード起動時に自動で読み込まれるモデルを設定できます。
`js/` フォルダに以下のいずれかのファイル名でモデルを配置してください：

| ファイル名 | 形式 |
|---|---|
| `model.glb` | GLB |
| `model.vrm` | VRM |
| `model.gltf` | GLTF |

優先順位は `model.glb` → `model.vrm` → `model.gltf` の順です。
いずれも存在しない場合はモデルなしで起動します。

### 背景画像

**BG** ボタンで PNG / JPG などの画像ファイルを読み込むと、Three.js シーン内の背景板（PlaneGeometry）として表示されます。
**📸 Capture** 時にはモデルと背景が同一レンダリングに含まれた状態で出力されます。
**✕** ボタンで背景を削除できます。

> `background_image` 入力ポートに別ノードから画像を接続した場合は、Python 側で Capture 後に合成されます（両方設定した場合は二重合成になるため注意）。

### Shape Keys（シェイプキー）

ノード下部の **Shape Keys** ヘッダーをクリックするとパネルが展開します。
モデルに含まれるシェイプキー・表情をスライダー（0.0 〜 1.0）でリアルタイムに操作できます。

| モデル形式 | 取得元 |
|---|---|
| GLTF / GLB | `morphTargetDictionary`（Blender などで設定した名前） |
| VRM | `ExpressionManager`（`happy`, `sad`, `blink` などの VRM 標準表情） |

### カラー補正（CC）

**CC** ボタンで sRGB カラースペース + ACES Filmic トーンマッピングを ON/OFF できます。
VROID Studio エクスポートや Blender 製モデルで暗く見える場合は ON にしてください。

### ポーズの保存・読み込み

**💾** ボタンで現在のポーズを `pose.json` としてダウンロードします。
**📂** ボタンまたはキャンバスへのドロップでポーズファイルを読み込みます。

対応フォーマット:

| フォーマット | 説明 |
|---|---|
| `.json`（自前形式） | 💾 ボタンで保存したファイル |
| `.vroidpose` | VRoid Studio のポーズファイル（体幹・腕・脚対応、手指は非対応） |

> キャンバスへのドロップは `.json` / `.vroidpose` のほか、`.vrm` / `.glb` / `.gltf` にも対応しています。

#### VRM0 / VRM1 間のポーズ互換

💾 で保存するポーズ JSON は **version 2 形式**（クォータニオン + `vrmVersion` タグ）です。  
VRM0 で保存したポーズを VRM1 モデルに読み込む場合（またはその逆）、クォータニオンの座標系変換を自動で適用します。  
旧形式（version 1、オイラー角）のファイルも引き続き読み込み可能です。

### コントロールポイントサイズ

**Point Size** スライダーでボーンの操作点（青い球）のサイズを 0.2〜3.0 の範囲で変更できます。
手の指ボーンなど密集した部分の操作がしやすくなります。

---

## ノードの入出力

| 項目 | 種類 | 説明 |
|---|---|---|
| `background_image` | IMAGE（オプション） | Python 側で Capture 画像に合成する背景 |
| `output_size_mode` | Standard / Background / Custom | 出力解像度の決定方法 |
| `custom_width` / `custom_height` | INT | Custom モード時の出力サイズ |
| **output: image** | IMAGE | ポーズキャプチャ画像（Torch テンソル） |

---

## 技術仕様

- **フロントエンド**: JavaScript + [Three.js r160](https://threejs.org/) + [@pixiv/three-vrm 2.1.0](https://github.com/pixiv/three-vrm)（esm.sh 経由）
- **バックエンド**: Python（Base64 PNG → PIL → Torch Tensor 変換）
- **キャプチャ解像度**: 600 × 600 px
- **デフォルトモデル**: `js/model.glb` / `js/model.vrm` / `js/model.gltf` のいずれかを配置（優先順に検索）
- **ポーズ JSON**: version 2 形式（クォータニオン + `vrmVersion` タグ、VRM0/VRM1 間互換）
- **VRM0 クォータニオン変換**: Unity 左手系 → Three.js 右手系 `(x, y, -z, -w)`
- **VRM1 クォータニオン変換**: VRM0変換後にVRM0→VRM1変換 `(x, -y, z, -w)` を追加適用
- **カメラ初期位置**: VRM0 ロード時は Z=-5（正面が Z 負方向）、VRM1/GLB は Z=+5 に自動切り替え

---

## License

MIT License
