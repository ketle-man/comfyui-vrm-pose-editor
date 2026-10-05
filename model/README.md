# model/

Place model files (`.vrm` / `.glb` / `.gltf`) here. Any file name is fine.

Choose which one is loaded automatically in **Light & Pose Editor → Light tab → S (Settings) → Default Model**.
The choice is saved to ComfyUI's user data (`user/<user>/vrm_pose_editor_settings.json`).

- `Auto`: the first file in this folder (by name). If the folder is empty, no model is loaded.
- `None`: no model is loaded on startup.

ここにモデル（`.vrm` / `.glb` / `.gltf`、ファイル名は自由）を置いてください。
どれを自動で読み込むかは **Light & Pose Editor → Lightタブ → S（Settings）→ Default Model** で選べます。
選択は ComfyUI のユーザーデータ（`user/<user>/vrm_pose_editor_settings.json`）に保存されます。

- `Auto`: このフォルダの先頭（名前順）のファイル。フォルダが空ならモデルを読み込みません。
- `None`: 起動時にモデルを読み込みません。
