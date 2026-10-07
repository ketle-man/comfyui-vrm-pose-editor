from .pose_editor_node_3d import NODE_CLASS_MAPPINGS as _POSE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as _POSE_DISPLAY_MAPPINGS
from .lip_sync_text_node import NODE_CLASS_MAPPINGS as _LIP_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as _LIP_DISPLAY_MAPPINGS
from . import pose_library_server  # noqa: F401 — デコレータでルートを登録する

NODE_CLASS_MAPPINGS = {**_POSE_CLASS_MAPPINGS, **_LIP_CLASS_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**_POSE_DISPLAY_MAPPINGS, **_LIP_DISPLAY_MAPPINGS}
from . import default_model_server  # noqa: F401 — model/ フォルダのモデル一覧・配信
from . import pose_audio_server  # noqa: F401 — 音声ファイル管理・Lemonade での音声作成・API 設定

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
