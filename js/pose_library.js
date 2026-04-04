/**
 * Pose Library UI
 * - .json / .vroidpose ポーズファイルのサムネイル一覧表示
 * - お気に入り / グループ / メモ / 検索
 * - VRMプレビューによるサムネイル自動生成
 */

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { VRMLoaderPlugin } from './vendor/three-vrm.module.js';

// ----------------------------------------------------------------
// ポーズライブラリを開く（外部から呼ぶエントリポイント）
// editor: initPoseEditor3D の戻り値（importPose を持つ）
// baseUrl: import.meta.url から取得したベースURL
// vrmBuffer: 現在ロード済みのVRMバッファ (ArrayBuffer|null)
// ----------------------------------------------------------------
export function openPoseLibrary(editor, baseUrl, vrmBuffer) {
    if (document.getElementById("pose-library-modal")) return; // 重複防止

    const modal = buildModal(editor, baseUrl, vrmBuffer);
    document.body.appendChild(modal);
    // フォーカストラップ
    setTimeout(() => modal.querySelector("#plb-dir-input")?.focus(), 50);
}

// ----------------------------------------------------------------
// モーダル本体の構築
// ----------------------------------------------------------------
function buildModal(editor, baseUrl, vrmBuffer) {
    // オーバーレイ
    const overlay = document.createElement("div");
    overlay.id = "pose-library-modal";
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;" +
        "display:flex;align-items:center;justify-content:center;";

    // ダイアログ本体
    const dialog = document.createElement("div");
    dialog.style.cssText =
        "background:#1e1e2e;color:#ccc;border-radius:10px;padding:0;" +
        "width:min(96vw,1000px);height:min(92vh,750px);display:flex;flex-direction:column;" +
        "box-shadow:0 8px 40px rgba(0,0,0,0.8);overflow:hidden;font-family:sans-serif;";

    // ESCキーで閉じる
    overlay.addEventListener("keydown", (e) => {
        if (e.key === "Escape") overlay.remove();
    });
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });

    // --- ヘッダー ---
    const header = document.createElement("div");
    header.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:10px 14px;" +
        "background:#16213e;border-bottom:1px solid #333;flex-shrink:0;";

    const title = document.createElement("span");
    title.textContent = "📚 Pose Library";
    title.style.cssText = "font-size:15px;font-weight:bold;color:#e0e0ff;flex:1;";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText =
        "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;padding:4px 8px;";
    closeBtn.onclick = () => overlay.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);

    // --- ツールバー ---
    const toolbar = document.createElement("div");
    toolbar.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:8px 12px;" +
        "background:#1a1a2e;border-bottom:1px solid #2a2a4a;flex-shrink:0;flex-wrap:wrap;";

    // ディレクトリ入力
    const dirLabel = document.createElement("span");
    dirLabel.textContent = "Dir:";
    dirLabel.style.cssText = "font-size:11px;color:#888;white-space:nowrap;";

    const dirInput = document.createElement("input");
    dirInput.id = "plb-dir-input";
    dirInput.type = "text";
    dirInput.placeholder = "ポーズフォルダのパスを入力…";
    dirInput.style.cssText =
        "flex:1;min-width:200px;background:#111;border:1px solid #444;color:#ddd;" +
        "padding:5px 8px;border-radius:4px;font-size:12px;";

    const loadDirBtn = makeBtn("🔍 Load", "#2a4a7a");
    loadDirBtn.title = "ディレクトリのポーズを読み込む";

    // 検索
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "検索…";
    searchInput.style.cssText =
        "width:140px;background:#111;border:1px solid #444;color:#ddd;" +
        "padding:5px 8px;border-radius:4px;font-size:12px;";

    // フィルター
    const filterSel = document.createElement("select");
    filterSel.style.cssText =
        "background:#111;border:1px solid #444;color:#ddd;padding:5px 6px;" +
        "border-radius:4px;font-size:12px;cursor:pointer;";
    [["all","すべて"],["favorite","⭐ お気に入り"],["json",".json"],["vroidpose",".vroidpose"]]
        .forEach(([v,t]) => {
            const o = document.createElement("option");
            o.value = v; o.textContent = t;
            filterSel.appendChild(o);
        });

    // グループフィルター
    const groupSel = document.createElement("select");
    groupSel.style.cssText =
        "background:#111;border:1px solid #444;color:#ddd;padding:5px 6px;" +
        "border-radius:4px;font-size:12px;cursor:pointer;";
    const groupAllOpt = document.createElement("option");
    groupAllOpt.value = ""; groupAllOpt.textContent = "グループ：すべて";
    groupSel.appendChild(groupAllOpt);

    // サムネイルサイズ
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "サイズ:";
    sizeLabel.style.cssText = "font-size:11px;color:#888;white-space:nowrap;";
    const sizeSel = document.createElement("select");
    sizeSel.style.cssText =
        "background:#111;border:1px solid #444;color:#ddd;padding:5px 6px;" +
        "border-radius:4px;font-size:12px;cursor:pointer;";
    [["s","小"],["m","中"],["l","大"]].forEach(([v,t]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t;
        if (v === "m") o.selected = true;
        sizeSel.appendChild(o);
    });

    toolbar.append(dirLabel, dirInput, loadDirBtn, searchInput, filterSel, groupSel, sizeLabel, sizeSel);

    // --- コンテンツエリア ---
    const content = document.createElement("div");
    content.style.cssText =
        "flex:1;overflow-y:auto;padding:10px 12px;box-sizing:border-box;";

    const grid = document.createElement("div");
    grid.id = "plb-grid";
    setGridSize(grid, "m");
    content.appendChild(grid);

    // --- ステータスバー ---
    const statusBar = document.createElement("div");
    statusBar.style.cssText =
        "padding:6px 14px;background:#111;border-top:1px solid #2a2a3a;" +
        "font-size:11px;color:#666;flex-shrink:0;";
    statusBar.textContent = "ポーズフォルダを指定して「Load」を押してください。";

    // ダイアログ組み立て
    dialog.append(header, toolbar, content, statusBar);
    overlay.appendChild(dialog);

    // ----------------------------------------------------------------
    // 状態管理
    // ----------------------------------------------------------------
    let allPoses = [];       // サーバーから取得した全ポーズリスト
    let groups   = new Set();

    function getCardSize(size) {
        return { s: 100, m: 140, l: 190 }[size] ?? 140;
    }

    function setGridSize(g, size) {
        const px = getCardSize(size);
        g.style.cssText =
            `display:grid;grid-template-columns:repeat(auto-fill,minmax(${px}px,1fr));` +
            "gap:8px;";
    }

    sizeSel.addEventListener("change", () => {
        setGridSize(grid, sizeSel.value);
        renderGrid();
    });

    // ----------------------------------------------------------------
    // サーバーAPIコール
    // ----------------------------------------------------------------
    async function loadDirectory(dir) {
        statusBar.textContent = "読み込み中…";
        grid.innerHTML = "";
        try {
            const res  = await fetch(`/pose_library/list?dir=${encodeURIComponent(dir)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            allPoses = data.poses;

            // グループリスト更新
            groups = new Set(allPoses.map(p => p.group).filter(Boolean));
            updateGroupSelect();

            statusBar.textContent = `${allPoses.length} 件のポーズを読み込みました。`;
            renderGrid();
        } catch (e) {
            statusBar.textContent = `エラー: ${e.message}`;
        }
    }

    async function patchMeta(id, patch) {
        await fetch("/pose_library/meta", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...patch }),
        });
        // ローカルにも反映
        const pose = allPoses.find(p => p.id === id);
        if (pose) Object.assign(pose, patch);
    }

    async function saveThumbnail(id, dataUrl) {
        await fetch(`/pose_library/thumbnail/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: dataUrl }),
        });
        const pose = allPoses.find(p => p.id === id);
        if (pose) pose.thumb = `/pose_library/thumbnail/${id}`;
    }

    async function loadPoseContent(path) {
        const res = await fetch(`/pose_library/content?path=${encodeURIComponent(path)}`);
        return await res.text();
    }

    // ----------------------------------------------------------------
    // グループセレクト更新
    // ----------------------------------------------------------------
    function updateGroupSelect() {
        // 既存のオプション（「すべて」以外）を削除
        while (groupSel.children.length > 1) groupSel.removeChild(groupSel.lastChild);
        for (const g of [...groups].sort()) {
            const o = document.createElement("option");
            o.value = g; o.textContent = g;
            groupSel.appendChild(o);
        }
    }

    // ----------------------------------------------------------------
    // フィルタリング
    // ----------------------------------------------------------------
    function filteredPoses() {
        const q      = searchInput.value.toLowerCase();
        const filter = filterSel.value;
        const group  = groupSel.value;
        return allPoses.filter(p => {
            if (q && !p.name.toLowerCase().includes(q) &&
                     !p.memo.toLowerCase().includes(q)) return false;
            if (filter === "favorite" && !p.favorite) return false;
            if (filter === "json"      && p.ext !== ".json") return false;
            if (filter === "vroidpose" && p.ext !== ".vroidpose") return false;
            if (group && p.group !== group) return false;
            return true;
        });
    }

    searchInput.addEventListener("input", renderGrid);
    filterSel.addEventListener("change", renderGrid);
    groupSel.addEventListener("change", renderGrid);

    // ----------------------------------------------------------------
    // グリッドレンダリング
    // ----------------------------------------------------------------
    function renderGrid() {
        grid.innerHTML = "";
        const poses = filteredPoses();
        if (poses.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "color:#555;font-size:13px;padding:20px;grid-column:1/-1;text-align:center;";
            empty.textContent = "ポーズが見つかりません。";
            grid.appendChild(empty);
            statusBar.textContent = "0 件";
            return;
        }
        statusBar.textContent = `${poses.length} 件`;
        const size = sizeSel.value;
        for (const pose of poses) {
            grid.appendChild(buildCard(pose, size));
        }
    }

    // ----------------------------------------------------------------
    // カード構築
    // ----------------------------------------------------------------
    function buildCard(pose, size) {
        const px = getCardSize(size);

        const card = document.createElement("div");
        card.style.cssText =
            `width:${px}px;background:#252540;border-radius:6px;overflow:hidden;` +
            "cursor:pointer;transition:box-shadow 0.15s;position:relative;" +
            "border:2px solid transparent;display:flex;flex-direction:column;";
        card.dataset.id = pose.id;

        card.addEventListener("mouseenter", () => {
            card.style.boxShadow = "0 0 0 2px #4a90d9";
            card.style.borderColor = "#4a90d9";
        });
        card.addEventListener("mouseleave", () => {
            card.style.boxShadow = "";
            card.style.borderColor = "transparent";
        });

        // サムネイル領域
        const thumbArea = document.createElement("div");
        thumbArea.style.cssText =
            `width:${px}px;height:${px}px;background:#1a1a30;overflow:hidden;` +
            "display:flex;align-items:center;justify-content:center;flex-shrink:0;";

        if (pose.thumb) {
            const img = document.createElement("img");
            img.src = pose.thumb + "?t=" + Date.now();
            img.style.cssText = `width:${px}px;height:${px}px;object-fit:cover;`;
            img.onerror = () => thumbArea.appendChild(makePlaceholder(px));
            thumbArea.appendChild(img);
        } else {
            thumbArea.appendChild(makePlaceholder(px));
            // バックグラウンドでサムネイル生成
            if (vrmBuffer) {
                generateThumbnail(pose, vrmBuffer, baseUrl).then(dataUrl => {
                    if (!dataUrl) return;
                    saveThumbnail(pose.id, dataUrl).then(() => {
                        const img = document.createElement("img");
                        img.src = `/pose_library/thumbnail/${pose.id}?t=` + Date.now();
                        img.style.cssText = `width:${px}px;height:${px}px;object-fit:cover;`;
                        thumbArea.innerHTML = "";
                        thumbArea.appendChild(img);
                    });
                }).catch(() => {});
            }
        }

        // ⭐ お気に入りボタン
        const starBtn = document.createElement("button");
        starBtn.textContent = pose.favorite ? "⭐" : "☆";
        starBtn.title = "お気に入り";
        starBtn.style.cssText =
            "position:absolute;top:3px;right:3px;background:rgba(0,0,0,0.6);" +
            "border:none;color:#ffd700;font-size:14px;cursor:pointer;border-radius:3px;" +
            "padding:1px 4px;line-height:1;z-index:2;";
        starBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            pose.favorite = !pose.favorite;
            starBtn.textContent = pose.favorite ? "⭐" : "☆";
            await patchMeta(pose.id, { favorite: pose.favorite });
            if (filterSel.value === "favorite") renderGrid();
        });

        // テキスト情報エリア
        const info = document.createElement("div");
        info.style.cssText = "padding:4px 6px;flex:1;min-height:0;overflow:hidden;";

        const nameEl = document.createElement("div");
        nameEl.textContent = pose.name;
        nameEl.title = pose.name;
        nameEl.style.cssText =
            "font-size:10px;color:#ccc;overflow:hidden;text-overflow:ellipsis;" +
            "white-space:nowrap;font-weight:bold;";

        const extBadge = document.createElement("span");
        extBadge.textContent = pose.ext;
        extBadge.style.cssText =
            "font-size:9px;background:#333;color:#888;padding:1px 4px;border-radius:3px;";

        const groupEl = document.createElement("div");
        groupEl.textContent = pose.group || "";
        groupEl.style.cssText = "font-size:9px;color:#6a8aaa;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

        info.append(nameEl, extBadge, groupEl);

        card.append(thumbArea, starBtn, info);

        // シングルクリック → ポーズ適用
        card.addEventListener("click", async () => {
            try {
                const content = await loadPoseContent(pose.path);
                editor.importPose(content);
                // 適用フラッシュ
                card.style.borderColor = "#28a745";
                setTimeout(() => { card.style.borderColor = "transparent"; }, 600);
            } catch (e) {
                alert("ポーズの適用に失敗しました: " + e.message);
            }
        });

        // 右クリック → コンテキストメニュー
        card.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, pose, card);
        });

        return card;
    }

    // ----------------------------------------------------------------
    // プレースホルダー
    // ----------------------------------------------------------------
    function makePlaceholder(px) {
        const el = document.createElement("div");
        el.style.cssText =
            `width:${px}px;height:${px}px;display:flex;align-items:center;` +
            "justify-content:center;font-size:28px;color:#333;";
        el.textContent = "🧍";
        return el;
    }

    // ----------------------------------------------------------------
    // 右クリックコンテキストメニュー
    // ----------------------------------------------------------------
    function showContextMenu(x, y, pose, card) {
        document.getElementById("plb-ctx")?.remove();

        const menu = document.createElement("div");
        menu.id = "plb-ctx";
        menu.style.cssText =
            `position:fixed;left:${x}px;top:${y}px;` +
            "background:#1e1e3a;border:1px solid #444;border-radius:6px;" +
            "z-index:100001;padding:4px 0;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.6);";

        function menuItem(label, action) {
            const item = document.createElement("div");
            item.textContent = label;
            item.style.cssText =
                "padding:7px 14px;cursor:pointer;font-size:12px;color:#ccc;white-space:nowrap;";
            item.addEventListener("mouseenter", () => item.style.background = "#2a3a5a");
            item.addEventListener("mouseleave", () => item.style.background = "");
            item.addEventListener("click", () => { menu.remove(); action(); });
            return item;
        }

        menu.appendChild(menuItem(pose.favorite ? "⭐ お気に入り解除" : "☆ お気に入りに追加", async () => {
            pose.favorite = !pose.favorite;
            await patchMeta(pose.id, { favorite: pose.favorite });
            renderGrid();
        }));

        menu.appendChild(menuItem("🗂 グループを設定", () => showGroupDialog(pose)));
        menu.appendChild(menuItem("📝 メモを編集",     () => showMemoDialog(pose)));

        if (vrmBuffer) {
            menu.appendChild(menuItem("🖼 サムネイルを再生成", async () => {
                const dataUrl = await generateThumbnail(pose, vrmBuffer, baseUrl);
                if (!dataUrl) { alert("サムネイル生成に失敗しました。"); return; }
                await saveThumbnail(pose.id, dataUrl);
                renderGrid();
            }));
        }

        document.body.appendChild(menu);

        // クリック外で閉じる
        const close = (e) => {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", close); }
        };
        setTimeout(() => document.addEventListener("click", close), 0);
    }

    // ----------------------------------------------------------------
    // グループ設定ダイアログ
    // ----------------------------------------------------------------
    function showGroupDialog(pose) {
        const existing = [...groups].sort();
        const current  = pose.group || "";

        const dlg = buildMiniDialog("🗂 グループを設定", () => dlg.remove());

        const body = document.createElement("div");
        body.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:8px;";

        const input = document.createElement("input");
        input.type  = "text";
        input.value = current;
        input.placeholder = "グループ名を入力（空白でなし）";
        input.style.cssText =
            "background:#111;border:1px solid #555;color:#ddd;padding:6px 10px;" +
            "border-radius:4px;font-size:13px;width:100%;box-sizing:border-box;";

        // 既存グループのクイック選択
        if (existing.length > 0) {
            const quickRow = document.createElement("div");
            quickRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
            for (const g of existing) {
                const chip = document.createElement("button");
                chip.textContent = g;
                chip.style.cssText =
                    `background:${g === current ? "#2a4a8a" : "#2a2a4a"};border:1px solid #444;` +
                    "color:#ccc;padding:3px 8px;border-radius:12px;cursor:pointer;font-size:11px;";
                chip.onclick = () => { input.value = g; };
                quickRow.appendChild(chip);
            }
            body.appendChild(quickRow);
        }

        body.appendChild(input);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";

        const okBtn = makeBtn("設定", "#2a6a3a");
        okBtn.onclick = async () => {
            const newGroup = input.value.trim();
            pose.group = newGroup;
            await patchMeta(pose.id, { group: newGroup });
            if (newGroup) groups.add(newGroup);
            updateGroupSelect();
            dlg.remove();
            renderGrid();
        };
        const cancelBtn = makeBtn("キャンセル", "#555");
        cancelBtn.onclick = () => dlg.remove();

        btnRow.append(cancelBtn, okBtn);
        body.appendChild(btnRow);
        dlg.querySelector(".plb-dlg-body").appendChild(body);
        document.body.appendChild(dlg);
        input.focus();
    }

    // ----------------------------------------------------------------
    // メモ編集ダイアログ
    // ----------------------------------------------------------------
    function showMemoDialog(pose) {
        const dlg = buildMiniDialog("📝 メモを編集", () => dlg.remove());

        const body = document.createElement("div");
        body.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:8px;";

        const textarea = document.createElement("textarea");
        textarea.value = pose.memo || "";
        textarea.rows  = 5;
        textarea.placeholder = "メモを入力…";
        textarea.style.cssText =
            "background:#111;border:1px solid #555;color:#ddd;padding:6px 10px;" +
            "border-radius:4px;font-size:12px;resize:vertical;width:100%;box-sizing:border-box;";

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";

        const okBtn = makeBtn("保存", "#2a6a3a");
        okBtn.onclick = async () => {
            pose.memo = textarea.value.trim();
            await patchMeta(pose.id, { memo: pose.memo });
            dlg.remove();
            renderGrid();
        };
        const cancelBtn = makeBtn("キャンセル", "#555");
        cancelBtn.onclick = () => dlg.remove();

        btnRow.append(cancelBtn, okBtn);
        body.append(textarea, btnRow);
        dlg.querySelector(".plb-dlg-body").appendChild(body);
        document.body.appendChild(dlg);
        textarea.focus();
    }

    // ----------------------------------------------------------------
    // ディレクトリロード
    // ----------------------------------------------------------------
    loadDirBtn.addEventListener("click", () => {
        const dir = dirInput.value.trim();
        if (!dir) return;
        loadDirectory(dir);
    });
    dirInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") loadDirBtn.click();
    });

    return overlay;
}

// ----------------------------------------------------------------
// 小ダイアログのシェル
// ----------------------------------------------------------------
function buildMiniDialog(titleText, onClose) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100002;" +
        "display:flex;align-items:center;justify-content:center;";

    const box = document.createElement("div");
    box.style.cssText =
        "background:#1e1e3a;border-radius:8px;min-width:320px;max-width:420px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,0.7);overflow:hidden;font-family:sans-serif;";

    const hdr = document.createElement("div");
    hdr.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;" +
        "padding:10px 14px;background:#16213e;border-bottom:1px solid #333;";
    const t = document.createElement("span");
    t.textContent = titleText;
    t.style.cssText = "font-size:13px;font-weight:bold;color:#e0e0ff;";
    const x = document.createElement("button");
    x.textContent = "✕";
    x.style.cssText = "background:none;border:none;color:#aaa;font-size:14px;cursor:pointer;";
    x.onclick = onClose;
    hdr.append(t, x);

    const body = document.createElement("div");
    body.className = "plb-dlg-body";

    box.append(hdr, body);
    overlay.appendChild(box);

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) onClose();
    });

    return overlay;
}

// ----------------------------------------------------------------
// サムネイル自動生成（オフスクリーンThree.js + VRM）
// ----------------------------------------------------------------
async function generateThumbnail(pose, vrmBuffer, baseUrl) {
    const SIZE = 256;
    try {
        // オフスクリーンキャンバス
        const offCanvas = document.createElement("canvas");
        offCanvas.width = SIZE; offCanvas.height = SIZE;

        const renderer = new THREE.WebGLRenderer({
            canvas: offCanvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
        });
        renderer.setSize(SIZE, SIZE, false);
        renderer.setClearColor(0x1a1a2e, 1);
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

        const scene  = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);

        scene.add(new THREE.AmbientLight(0xffffff, 1.2));
        const dir = new THREE.DirectionalLight(0xffffff, 1.5);
        dir.position.set(1, 2, 2);
        scene.add(dir);

        // VRMロード
        const loader = new GLTFLoader();
        loader.register(parser => new VRMLoaderPlugin(parser));

        const blob = new Blob([vrmBuffer]);
        const url  = URL.createObjectURL(blob);

        let vrm;
        try {
            const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
            vrm = gltf.userData.vrm;
        } finally {
            URL.revokeObjectURL(url);
        }
        if (!vrm) return null;

        scene.add(vrm.scene);
        vrm.scene.updateMatrixWorld(true);

        // ポーズ適用（poseのpathからファイルを読む）
        try {
            const res     = await fetch(`/pose_library/content?path=${encodeURIComponent(pose.path)}`);
            const poseStr = await res.text();
            applyPoseToVRM(vrm, poseStr);
        } catch (_) { /* ポーズ適用失敗でもサムネイル生成は続ける */ }

        vrm.update(0);
        vrm.scene.updateMatrixWorld(true);

        // カメラをバウンディングボックスに合わせる
        const box    = new THREE.Box3().setFromObject(vrm.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const dist   = (maxDim / 2) / Math.tan((30 / 2) * Math.PI / 180) * 1.4;
        camera.position.set(center.x, center.y + size.y * 0.05, center.z - dist);
        camera.lookAt(center.x, center.y, center.z);

        renderer.render(scene, camera);

        const dataUrl = offCanvas.toDataURL("image/png");
        renderer.dispose();
        return dataUrl;
    } catch (e) {
        console.warn("[PoseLibrary] thumbnail generation failed:", e);
        return null;
    }
}

// ----------------------------------------------------------------
// VRMへポーズ適用（pose_editor_3d.js の importPose と同等の簡易版）
// .vroidpose / version2 JSON / version1 JSON に対応
// ----------------------------------------------------------------
function applyPoseToVRM(vrm, poseText) {
    const parsed = JSON.parse(poseText);
    const isVrm0 = (vrm.meta?.metaVersion ?? "0") === "0";

    // .vroidpose 形式
    if (parsed.BoneDefinition) {
        const VROID_TO_VRM = {
            Hips:"hips", Spine:"spine", Chest:"chest", UpperChest:"upperChest",
            Neck:"neck", Head:"head",
            LeftShoulder:"leftShoulder", LeftUpperArm:"leftUpperArm",
            LeftLowerArm:"leftLowerArm", LeftHand:"leftHand",
            RightShoulder:"rightShoulder", RightUpperArm:"rightUpperArm",
            RightLowerArm:"rightLowerArm", RightHand:"rightHand",
            LeftUpperLeg:"leftUpperLeg", LeftLowerLeg:"leftLowerLeg",
            LeftFoot:"leftFoot", LeftToes:"leftToes",
            RightUpperLeg:"rightUpperLeg", RightLowerLeg:"rightLowerLeg",
            RightFoot:"rightFoot", RightToes:"rightToes",
        };
        const BONE_CORRECTION_X_VRM0 = {
            Spine:10, Chest:-18, UpperChest:-9, Neck:15, Head:0,
            LeftUpperLeg:2, RightUpperLeg:2, LeftShoulder:16, RightShoulder:16,
        };
        const BONE_CORRECTION_X_VRM1 = {
            Spine:-10, Chest:18, UpperChest:9, Neck:-15, Head:0,
            LeftUpperLeg:-2, RightUpperLeg:-2, LeftShoulder:-16, RightShoulder:-16,
        };
        const corr = isVrm0 ? BONE_CORRECTION_X_VRM0 : BONE_CORRECTION_X_VRM1;
        const bd   = parsed.BoneDefinition;

        for (const [vroidKey, vrmKey] of Object.entries(VROID_TO_VRM)) {
            const r = bd[vroidKey];
            if (!r) continue;
            const node = vrm.humanoid.getNormalizedBoneNode(vrmKey);
            if (!node) continue;

            const base = new THREE.Quaternion(r.x, r.y, -r.z, -r.w).normalize();
            if (!isVrm0) base.set(base.x, -base.y, base.z, -base.w).normalize();

            const corrDeg = corr[vroidKey];
            if (corrDeg) {
                const c = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(THREE.MathUtils.degToRad(corrDeg), 0, 0)
                );
                c.premultiply(base);
                node.quaternion.copy(c);
            } else {
                node.quaternion.copy(base);
            }
        }
        vrm.humanoid.update();
        return;
    }

    // version2 JSON
    if (parsed.version === 2 && parsed.bones) {
        const q = new THREE.Quaternion();
        const humanoid = vrm.humanoid;
        for (const [key, bd] of Object.entries(parsed.bones)) {
            // humanoidBoneName として探す
            const node = humanoid.getNormalizedBoneNode(key) ??
                         humanoid.getNormalizedBoneNode(key.charAt(0).toLowerCase() + key.slice(1));
            if (!node) continue;
            q.set(bd.qx, bd.qy, bd.qz, bd.qw);
            node.quaternion.copy(q);
        }
        vrm.humanoid.update();
        return;
    }

    // version1 JSON（オイラー角）
    const bones = parsed.bones ?? parsed;
    const allNodes = vrm.humanoid.humanBones;
    for (const [key, val] of Object.entries(bones)) {
        const node = vrm.humanoid.getNormalizedBoneNode(key) ??
                     vrm.humanoid.getNormalizedBoneNode(key.charAt(0).toLowerCase() + key.slice(1));
        if (!node) continue;
        node.rotation.x = val.x ?? 0;
        node.rotation.y = val.y ?? 0;
        node.rotation.z = val.z ?? 0;
    }
    vrm.humanoid.update();
}

// ----------------------------------------------------------------
// ボタン生成ヘルパー
// ----------------------------------------------------------------
function makeBtn(label, bg) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText =
        `padding:5px 12px;background:${bg};color:#fff;border:none;` +
        "border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;" +
        "white-space:nowrap;transition:opacity 0.15s;";
    btn.addEventListener("mouseenter", () => btn.style.opacity = "0.8");
    btn.addEventListener("mouseleave", () => btn.style.opacity = "1");
    return btn;
}
