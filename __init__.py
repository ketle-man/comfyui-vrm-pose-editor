from .pose_editor_node_3d import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import pose_library_server  # noqa: F401 — デコレータでルートを登録する

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
