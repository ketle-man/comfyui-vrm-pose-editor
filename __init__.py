from .pose_editor_node_3d import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .pose_library_server import register_routes

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


def on_start(routes):
    register_routes(routes)


# ComfyUI が WEB_DIRECTORY を検出して JS を配信し、
# on_start でサーバールートを登録する。
try:
    from server import PromptServer
    register_routes(PromptServer.instance.app.router)
except Exception:
    pass
