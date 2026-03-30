import torch
import numpy as np
from PIL import Image
import base64
import io


class PoseEditor3DNode:
    """
    3D GLTF ポーズエディタ ノード
    - ポーズエディタで 3D モデルを操作し IMAGE として出力
    - background_image 入力で背景合成対応
    - output_size_mode: Standard / Background / Custom
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_data":       ("STRING", {"default": ""}),
                "output_size_mode": (["Standard", "Background", "Custom"], {"default": "Standard"}),
                "custom_width":     ("INT", {"default": 600, "min": 64, "max": 4096, "step": 8}),
                "custom_height":    ("INT", {"default": 600, "min": 64, "max": 4096, "step": 8}),
            },
            "optional": {
                "background_image": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "export_pose"
    CATEGORY = "3D Pose"
    OUTPUT_NODE = False

    def export_pose(self,
                    image_data: str,
                    output_size_mode: str = "Standard",
                    custom_width: int = 600,
                    custom_height: int = 600,
                    background_image=None):

        # ---- 背景画像の準備 ----
        bg_pil = None
        if background_image is not None:
            bg_np = (background_image[0].numpy() * 255).clip(0, 255).astype(np.uint8)
            bg_pil = Image.fromarray(bg_np).convert("RGBA")

        # ---- image_data デコード ----
        pose_pil = None
        if image_data and image_data.strip():
            try:
                data = image_data
                if "," in data:
                    data = data.split(",", 1)[1]
                pose_pil = Image.open(io.BytesIO(base64.b64decode(data))).convert("RGBA")
            except Exception as e:
                print(f"[PoseEditor3D] 画像デコードエラー: {e}")

        # ---- 出力サイズ決定 ----
        if output_size_mode == "Background" and bg_pil is not None:
            out_w, out_h = bg_pil.size
        elif output_size_mode == "Custom":
            out_w, out_h = custom_width, custom_height
        else:  # Standard
            if pose_pil is not None:
                out_w, out_h = pose_pil.size
            elif bg_pil is not None:
                out_w, out_h = bg_pil.size
            else:
                out_w, out_h = 600, 600

        # ---- 合成 ----
        # 3D版もデフォルトは薄いグレーの背景
        result = Image.new("RGBA", (out_w, out_h), (224, 224, 224, 255))

        # 背景画像がある場合は重ねる
        if bg_pil is not None:
            bg_resized = bg_pil.resize((out_w, out_h), Image.LANCZOS) if bg_pil.size != (out_w, out_h) else bg_pil
            result.paste(bg_resized, (0, 0))

        # 3Dキャプチャ画像を重ねる（アルファ合成）
        if pose_pil is not None:
            pose_resized = pose_pil.resize((out_w, out_h), Image.LANCZOS) if pose_pil.size != (out_w, out_h) else pose_pil
            result.paste(pose_resized, (0, 0), pose_resized)

        # ---- テンソル変換 ----
        result_rgb = result.convert("RGB")
        img_array = np.array(result_rgb).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_array).unsqueeze(0)  # (1, H, W, C)
        return (img_tensor,)

    @classmethod
    def IS_CHANGED(cls, image_data, output_size_mode="Standard",
                   custom_width=600, custom_height=600, background_image=None):
        import hashlib
        key = f"{image_data}|{output_size_mode}|{custom_width}|{custom_height}"
        return hashlib.md5(key.encode()).hexdigest()


NODE_CLASS_MAPPINGS = {
    "PoseEditor3D": PoseEditor3DNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PoseEditor3D": "3D Pose Editor",
}
