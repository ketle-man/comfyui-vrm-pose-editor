class LipSyncTextNode:
    """
    リップシンク用テキスト出力ノード
    - 入力されたテキストを STRING として出力する
    - TTS ノード（外部ノード）へ渡すテキストを分岐させ、後段の口形同期で使う受け渡し口
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "output_text"
    CATEGORY = "3D Pose"
    OUTPUT_NODE = False

    def output_text(self, text: str):
        return (text,)


NODE_CLASS_MAPPINGS = {
    "LipSyncText": LipSyncTextNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LipSyncText": "Lip Sync Text",
}
