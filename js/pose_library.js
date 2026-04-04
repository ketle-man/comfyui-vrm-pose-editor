/**
 * Pose Library UI
 * - poses/ フォルダ固定（サーバー側で解決）
 * - サブディレクトリによるフィルタリング
 * - .json / .vroidpose サムネイル一覧
 * - お気に入り / メモ / 検索（名前のみ）
 * - poses/ へのポーズ保存（p_HHMMSS.json）
 * - ファイル名変更
 * - VRMによるサムネイル自動生成（正面向き固定）
 */

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { VRMLoaderPlugin } from './vendor/three-vrm.module.js';

// ----------------------------------------------------------------
// エントリポイント
// editor: initPoseEditor3D の戻り値（importPose / exportPose を持つ）
// vrmBuffer: 現在ロード済みのVRMバッファ (ArrayBuffer|null)
// ----------------------------------------------------------------
export function openPoseLibrary(editor, vrmBuffer) {
    if (document.getElementById("pose-library-modal")) return;
    document.body.appendChild(buildModal(editor, vrmBuffer));
}

// ----------------------------------------------------------------
// モーダル本体
// ----------------------------------------------------------------
function buildModal(editor, vrmBuffer) {
    const overlay = el("div", {
        id: "pose-library-modal",
        style: "position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:99999;" +
               "display:flex;align-items:center;justify-content:center;",
    });
    overlay.addEventListener("keydown", e => { if (e.key === "Escape") overlay.remove(); });
    overlay.addEventListener("click",   e => { if (e.target === overlay) overlay.remove(); });

    const dialog = el("div", {
        style: "background:#1e1e2e;color:#ccc;border-radius:10px;" +
               "width:min(96vw,1040px);height:min(92vh,760px);display:flex;flex-direction:column;" +
               "box-shadow:0 8px 40px rgba(0,0,0,0.85);overflow:hidden;font-family:sans-serif;",
    });

    // ---- ヘッダー ----
    const header = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:10px 14px;" +
               "background:#16213e;border-bottom:1px solid #333;flex-shrink:0;",
    });
    const titleEl  = el("span", { style: "font-size:15px;font-weight:bold;color:#e0e0ff;flex:1;" }, "📚 Pose Library");
    const reloadBtn = mkBtn("↺", "#2a4a7a", "ポーズ一覧を再読み込み");
    reloadBtn.style.padding = "3px 9px";
    const closeBtn = el("button", {
        style: "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;padding:4px 8px;",
    }, "✕");
    closeBtn.onclick = () => overlay.remove();
    header.append(titleEl, reloadBtn, closeBtn);

    // ---- ツールバー ----
    const toolbar = el("div", {
        style: "display:flex;align-items:center;gap:6px;padding:7px 12px;" +
               "background:#1a1a2e;border-bottom:1px solid #2a2a4a;flex-shrink:0;flex-wrap:wrap;",
    });

    // サブディレクトリ（フォルダ）フィルター
    const subdirSel = el("select", {
        style: "background:#111;border:1px solid #444;color:#ddd;padding:5px 7px;" +
               "border-radius:4px;font-size:12px;cursor:pointer;",
    });
    const allOpt = el("option", { value: "" }, "📁 すべて");
    subdirSel.appendChild(allOpt);

    // 検索（名前のみ）
    const searchInput = el("input", {
        type: "text", placeholder: "名前で検索…",
        style: "flex:1;min-width:120px;background:#111;border:1px solid #444;color:#ddd;" +
               "padding:5px 8px;border-radius:4px;font-size:12px;",
    });

    // フィルター
    const filterSel = el("select", {
        style: "background:#111;border:1px solid #444;color:#ddd;padding:5px 6px;" +
               "border-radius:4px;font-size:12px;cursor:pointer;",
    });
    [["all","すべて"],["favorite","⭐ お気に入り"],["json",".json"],["vroidpose",".vroidpose"]]
        .forEach(([v,t]) => filterSel.appendChild(el("option", { value: v }, t)));

    // サムネイルサイズ
    const sizeSel = el("select", {
        style: "background:#111;border:1px solid #444;color:#ddd;padding:5px 6px;" +
               "border-radius:4px;font-size:12px;cursor:pointer;",
    });
    [["s","小"],["m","中"],["l","大"]].forEach(([v,t]) => {
        const o = el("option", { value: v }, t);
        if (v === "m") o.selected = true;
        sizeSel.appendChild(o);
    });

    // ポーズ保存ボタン
    const savePoseBtn = mkBtn("💾 保存", "#4a7a4a", "現在のポーズを poses/ に保存");

    toolbar.append(subdirSel, searchInput, filterSel, sizeSel, savePoseBtn);

    // ---- コンテンツ ----
    const content = el("div", { style: "flex:1;overflow-y:auto;padding:10px 12px;box-sizing:border-box;" });
    const grid    = el("div", { id: "plb-grid" });
    setGridCss(grid, "m");
    content.appendChild(grid);

    // ---- ステータスバー ----
    const statusBar = el("div", {
        style: "padding:5px 14px;background:#111;border-top:1px solid #2a2a3a;" +
               "font-size:10px;color:#555;flex-shrink:0;display:flex;gap:10px;align-items:center;",
    });
    const statusMsg  = el("span", { style: "flex:1;" });
    const statusPath = el("span", { style: "color:#3a5a7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%;" });
    statusBar.append(statusMsg, statusPath);

    dialog.append(header, toolbar, content, statusBar);
    overlay.appendChild(dialog);

    // ----------------------------------------------------------------
    // 状態
    // ----------------------------------------------------------------
    let allPoses    = [];
    let currentSubdir = "";

    function getCardPx(s) { return { s: 100, m: 140, l: 190 }[s] ?? 140; }
    function setGridCss(g, s) {
        const px = getCardPx(s);
        g.style.cssText = `display:grid;grid-template-columns:repeat(auto-fill,minmax(${px}px,1fr));gap:8px;`;
    }

    // ----------------------------------------------------------------
    // API
    // ----------------------------------------------------------------
    async function apiFetch(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
        return res.json();
    }

    async function loadSubdirs() {
        try {
            const data = await apiFetch("/pose_library/subdirs");
            // subdirSel を再構築
            while (subdirSel.children.length > 1) subdirSel.removeChild(subdirSel.lastChild);
            for (const d of data.subdirs ?? []) {
                subdirSel.appendChild(el("option", { value: d }, `📂 ${d}`));
            }
        } catch (e) {
            console.warn("[PoseLibrary] subdirs failed:", e);
        }
    }

    async function loadPoses() {
        statusMsg.textContent = "読み込み中…";
        grid.innerHTML = "";
        try {
            const params = currentSubdir ? `?subdir=${encodeURIComponent(currentSubdir)}` : "";
            const data   = await apiFetch("/pose_library/list" + params);
            allPoses     = data.poses ?? [];
            statusPath.textContent = data.poses_dir ?? "";
            statusMsg.textContent  = `${allPoses.length} 件`;
            renderGrid();
        } catch (e) {
            statusMsg.textContent = `エラー: ${e.message}`;
            console.error("[PoseLibrary]", e);
        }
    }

    async function reload() {
        await loadSubdirs();
        await loadPoses();
    }

    async function patchMeta(id, patch) {
        await fetch("/pose_library/meta", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...patch }),
        });
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
    }

    // ----------------------------------------------------------------
    // フィルタリング
    // ----------------------------------------------------------------
    function filtered() {
        const q = searchInput.value.toLowerCase();
        const f = filterSel.value;
        return allPoses.filter(p => {
            if (q && !p.name.toLowerCase().includes(q)) return false;
            if (f === "favorite" && !p.favorite)        return false;
            if (f === "json"      && p.ext !== ".json")      return false;
            if (f === "vroidpose" && p.ext !== ".vroidpose") return false;
            return true;
        });
    }

    searchInput.addEventListener("input",  renderGrid);
    filterSel.addEventListener("change",   renderGrid);
    sizeSel.addEventListener("change",   () => { setGridCss(grid, sizeSel.value); renderGrid(); });
    subdirSel.addEventListener("change", () => { currentSubdir = subdirSel.value; loadPoses(); });
    reloadBtn.addEventListener("click",  reload);

    // ----------------------------------------------------------------
    // ポーズ保存
    // ----------------------------------------------------------------
    savePoseBtn.addEventListener("click", async () => {
        const poseJson = editor.exportPose?.();
        if (!poseJson) { alert("ポーズデータがありません。"); return; }
        try {
            const data = await apiFetch("/pose_library/save_pose", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ json: poseJson, subdir: currentSubdir }),
            });
            statusMsg.textContent = `保存: ${data.name}`;
            await loadPoses();
            // 新しく追加されたカードにサムネイル生成
            if (vrmBuffer) {
                const newPose = allPoses.find(p => p.path === data.path);
                if (newPose) {
                    generateThumbnail(newPose, vrmBuffer).then(dataUrl => {
                        if (dataUrl) saveThumbnail(newPose.id, dataUrl).then(renderGrid);
                    }).catch(() => {});
                }
            }
        } catch (e) {
            alert("保存に失敗しました: " + e.message);
        }
    });

    // ----------------------------------------------------------------
    // グリッド描画
    // ----------------------------------------------------------------
    function renderGrid() {
        grid.innerHTML = "";
        const poses = filtered();
        if (poses.length === 0) {
            const empty = el("div", {
                style: "color:#555;font-size:13px;padding:30px;grid-column:1/-1;text-align:center;",
            }, allPoses.length === 0
                ? "poses/ フォルダにポーズファイルがありません。"
                : "条件に一致するポーズがありません。");
            grid.appendChild(empty);
            statusMsg.textContent = "0 件";
            return;
        }
        statusMsg.textContent = `${poses.length} 件`;
        for (const pose of poses) grid.appendChild(buildCard(pose));
    }

    // ----------------------------------------------------------------
    // カード
    // ----------------------------------------------------------------
    function buildCard(pose) {
        const px = getCardPx(sizeSel.value);

        const card = el("div", {
            style: `width:${px}px;background:#252540;border-radius:6px;overflow:hidden;` +
                   "cursor:pointer;position:relative;border:2px solid transparent;" +
                   "display:flex;flex-direction:column;transition:border-color 0.12s;",
        });
        card.addEventListener("mouseenter", () => card.style.borderColor = "#4a90d9");
        card.addEventListener("mouseleave", () => card.style.borderColor = "transparent");

        // サムネイル
        const thumbArea = el("div", {
            style: `width:${px}px;height:${px}px;background:#1a1a30;overflow:hidden;` +
                   "display:flex;align-items:center;justify-content:center;flex-shrink:0;",
        });

        function setThumbImg(src) {
            const img = new Image();
            img.style.cssText = `width:${px}px;height:${px}px;object-fit:cover;`;
            img.src = src;
            img.onerror = () => { thumbArea.innerHTML = ""; thumbArea.appendChild(placeholderEl(px)); };
            thumbArea.innerHTML = "";
            thumbArea.appendChild(img);
        }

        if (pose.thumb) {
            setThumbImg(pose.thumb + "?t=" + Date.now());
        } else {
            thumbArea.appendChild(placeholderEl(px));
            if (vrmBuffer) {
                generateThumbnail(pose, vrmBuffer).then(dataUrl => {
                    if (!dataUrl) return;
                    return saveThumbnail(pose.id, dataUrl).then(() => {
                        setThumbImg(`/pose_library/thumbnail/${pose.id}?t=` + Date.now());
                    });
                }).catch(() => {});
            }
        }

        // ⭐ ボタン
        const starBtn = el("button", {
            style: "position:absolute;top:3px;right:3px;background:rgba(0,0,0,0.55);" +
                   "border:none;color:#ffd700;font-size:14px;cursor:pointer;" +
                   "border-radius:3px;padding:1px 4px;line-height:1;z-index:2;",
            title: "お気に入り",
        }, pose.favorite ? "⭐" : "☆");
        starBtn.addEventListener("click", async e => {
            e.stopPropagation();
            pose.favorite = !pose.favorite;
            starBtn.textContent = pose.favorite ? "⭐" : "☆";
            await patchMeta(pose.id, { favorite: pose.favorite });
            if (filterSel.value === "favorite") renderGrid();
        });

        // テキスト情報
        const info = el("div", { style: "padding:4px 5px;flex:1;overflow:hidden;" });
        const nameEl = el("div", {
            title: pose.name,
            style: "font-size:10px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:bold;",
        }, pose.name);
        const extBadge = el("span", {
            style: "font-size:9px;background:#2a2a44;color:#7a8aaa;padding:1px 4px;border-radius:3px;",
        }, pose.ext);
        const memoEl = el("div", {
            title: pose.memo || "",
            style: "font-size:9px;color:#666;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        }, pose.memo ? pose.memo.slice(0, 40) : "");
        info.append(nameEl, extBadge, memoEl);

        card.append(thumbArea, starBtn, info);

        // クリック → ポーズ適用
        card.addEventListener("click", async () => {
            try {
                const content = await loadPoseContent(pose.path);
                editor.importPose(content);
                card.style.borderColor = "#28a745";
                setTimeout(() => { card.style.borderColor = "transparent"; }, 700);
            } catch (e) {
                alert("ポーズの適用に失敗しました: " + e.message);
            }
        });

        // 右クリック → コンテキストメニュー
        card.addEventListener("contextmenu", e => {
            e.preventDefault();
            showCtxMenu(e.clientX, e.clientY, pose, thumbArea, setThumbImg);
        });

        return card;
    }

    // ----------------------------------------------------------------
    // プレースホルダー
    // ----------------------------------------------------------------
    function placeholderEl(px) {
        return el("div", {
            style: `width:${px}px;height:${px}px;display:flex;align-items:center;` +
                   "justify-content:center;font-size:28px;color:#333;",
        }, "🧍");
    }

    // ----------------------------------------------------------------
    // コンテキストメニュー
    // ----------------------------------------------------------------
    function showCtxMenu(x, y, pose, thumbArea, setThumbImg) {
        document.getElementById("plb-ctx")?.remove();

        const menu = el("div", {
            id: "plb-ctx",
            style: `position:fixed;left:${x}px;top:${y}px;` +
                   "background:#1e1e3a;border:1px solid #444;border-radius:6px;" +
                   "z-index:100001;padding:4px 0;min-width:170px;" +
                   "box-shadow:0 4px 16px rgba(0,0,0,0.7);font-family:sans-serif;",
        });

        const menuItem = (label, fn) => {
            const item = el("div", {
                style: "padding:7px 14px;cursor:pointer;font-size:12px;color:#ccc;white-space:nowrap;",
            }, label);
            item.addEventListener("mouseenter", () => item.style.background = "#2a3a5a");
            item.addEventListener("mouseleave", () => item.style.background = "");
            item.addEventListener("click", () => { menu.remove(); fn(); });
            return item;
        };

        menu.appendChild(menuItem(
            pose.favorite ? "⭐ お気に入り解除" : "☆ お気に入りに追加",
            async () => {
                pose.favorite = !pose.favorite;
                await patchMeta(pose.id, { favorite: pose.favorite });
                renderGrid();
            }
        ));
        menu.appendChild(menuItem("📝 メモを編集",      () => showMemoDlg(pose)));
        menu.appendChild(menuItem("✏️ ファイル名変更",   () => showRenameDlg(pose)));

        if (vrmBuffer) {
            menu.appendChild(menuItem("🖼 サムネイルを再生成", async () => {
                const dataUrl = await generateThumbnail(pose, vrmBuffer);
                if (!dataUrl) { alert("サムネイル生成に失敗しました。"); return; }
                await saveThumbnail(pose.id, dataUrl);
                setThumbImg(`/pose_library/thumbnail/${pose.id}?t=` + Date.now());
            }));
        }

        document.body.appendChild(menu);
        const close = e => {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", close); }
        };
        setTimeout(() => document.addEventListener("click", close), 0);
    }

    // ----------------------------------------------------------------
    // メモ編集ダイアログ
    // ----------------------------------------------------------------
    function showMemoDlg(pose) {
        const dlg  = miniDlg("📝 メモを編集", () => dlg.remove());
        const body = dlg.querySelector(".plb-dlg-body");
        const wrap = el("div", { style: "padding:12px;display:flex;flex-direction:column;gap:8px;" });

        const ta = el("textarea", {
            rows: 5, placeholder: "メモを入力…",
            style: "background:#111;border:1px solid #555;color:#ddd;padding:6px 10px;" +
                   "border-radius:4px;font-size:12px;resize:vertical;width:100%;box-sizing:border-box;",
        });
        ta.value = pose.memo || "";

        const btnRow = el("div", { style: "display:flex;gap:6px;justify-content:flex-end;" });
        const ok     = mkBtn("保存", "#2a6a3a");
        const cancel = mkBtn("キャンセル", "#555");
        ok.onclick = async () => {
            pose.memo = ta.value.trim();
            await patchMeta(pose.id, { memo: pose.memo });
            dlg.remove();
            renderGrid();
        };
        cancel.onclick = () => dlg.remove();
        btnRow.append(cancel, ok);
        wrap.append(ta, btnRow);
        body.appendChild(wrap);
        document.body.appendChild(dlg);
        ta.focus();
    }

    // ----------------------------------------------------------------
    // ファイル名変更ダイアログ
    // ----------------------------------------------------------------
    function showRenameDlg(pose) {
        const dlg  = miniDlg("✏️ ファイル名変更", () => dlg.remove());
        const body = dlg.querySelector(".plb-dlg-body");
        const wrap = el("div", { style: "padding:12px;display:flex;flex-direction:column;gap:8px;" });

        const hint = el("div", {
            style: "font-size:11px;color:#888;",
        }, `現在: ${pose.name}${pose.ext}`);

        const input = el("input", {
            type: "text",
            style: "background:#111;border:1px solid #555;color:#ddd;padding:6px 10px;" +
                   "border-radius:4px;font-size:13px;width:100%;box-sizing:border-box;",
        });
        input.value = pose.name;

        const errMsg = el("div", { style: "font-size:11px;color:#f66;min-height:14px;" });

        const btnRow = el("div", { style: "display:flex;gap:6px;justify-content:flex-end;" });
        const ok     = mkBtn("変更", "#2a5a8a");
        const cancel = mkBtn("キャンセル", "#555");

        ok.onclick = async () => {
            const newName = input.value.trim();
            if (!newName) { errMsg.textContent = "名前を入力してください。"; return; }
            try {
                const data = await apiFetch("/pose_library/rename", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: pose.path, new_name: newName }),
                });
                // ローカル状態を更新
                pose.path = data.path;
                pose.id   = data.new_id;
                pose.name = data.new_name;
                dlg.remove();
                renderGrid();
            } catch (e) {
                errMsg.textContent = e.message.includes("409")
                    ? "その名前は既に使われています。"
                    : `エラー: ${e.message}`;
            }
        };
        cancel.onclick = () => dlg.remove();
        input.addEventListener("keydown", e => { if (e.key === "Enter") ok.onclick(); });

        btnRow.append(cancel, ok);
        wrap.append(hint, input, errMsg, btnRow);
        body.appendChild(wrap);
        document.body.appendChild(dlg);
        input.select();
    }

    // 初回ロード
    reload();

    return overlay;
}

// ----------------------------------------------------------------
// 小ダイアログシェル
// ----------------------------------------------------------------
function miniDlg(titleText, onClose) {
    const overlay = el("div", {
        style: "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100002;" +
               "display:flex;align-items:center;justify-content:center;",
    });
    overlay.addEventListener("click", e => { if (e.target === overlay) onClose(); });

    const box = el("div", {
        style: "background:#1e1e3a;border-radius:8px;min-width:320px;max-width:420px;" +
               "box-shadow:0 6px 24px rgba(0,0,0,0.7);overflow:hidden;font-family:sans-serif;",
    });

    const hdr = el("div", {
        style: "display:flex;align-items:center;justify-content:space-between;" +
               "padding:10px 14px;background:#16213e;border-bottom:1px solid #333;",
    });
    const t = el("span", { style: "font-size:13px;font-weight:bold;color:#e0e0ff;" }, titleText);
    const x = el("button", { style: "background:none;border:none;color:#aaa;font-size:14px;cursor:pointer;" }, "✕");
    x.onclick = onClose;
    hdr.append(t, x);

    const body = el("div", { className: "plb-dlg-body" });
    box.append(hdr, body);
    overlay.appendChild(box);
    return overlay;
}

// ----------------------------------------------------------------
// サムネイル自動生成（正面向き・オフスクリーンThree.js + VRM）
// ----------------------------------------------------------------
async function generateThumbnail(pose, vrmBuffer) {
    const SIZE = 256;
    try {
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

        // ポーズ適用
        try {
            const res     = await fetch(`/pose_library/content?path=${encodeURIComponent(pose.path)}`);
            const poseStr = await res.text();
            applyPoseToVRM(vrm, poseStr);
        } catch (_) {}

        vrm.update(0);
        vrm.scene.updateMatrixWorld(true);

        // バウンディングボックスでカメラ配置
        const box    = new THREE.Box3().setFromObject(vrm.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const dist   = (maxDim / 2) / Math.tan((30 / 2) * Math.PI / 180) * 1.4;

        // 正面 = モデルのZ+ 方向（VRMは+Z が前）なので、カメラをZ+側に置く
        camera.position.set(center.x, center.y + size.y * 0.05, center.z + dist);
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
// VRMへポーズ適用（.vroidpose / version2 JSON / version1 JSON）
// ----------------------------------------------------------------
function applyPoseToVRM(vrm, poseText) {
    let parsed;
    try { parsed = JSON.parse(poseText); } catch { return; }

    const isVrm0 = (vrm.meta?.metaVersion ?? "0") === "0";

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
        const CORR_VRM0 = {
            Spine:10, Chest:-18, UpperChest:-9, Neck:15, Head:0,
            LeftUpperLeg:2, RightUpperLeg:2, LeftShoulder:16, RightShoulder:16,
        };
        const CORR_VRM1 = {
            Spine:-10, Chest:18, UpperChest:9, Neck:-15, Head:0,
            LeftUpperLeg:-2, RightUpperLeg:-2, LeftShoulder:-16, RightShoulder:-16,
        };
        const corr = isVrm0 ? CORR_VRM0 : CORR_VRM1;
        const bd   = parsed.BoneDefinition;
        for (const [vk, vrmKey] of Object.entries(VROID_TO_VRM)) {
            const r = bd[vk]; if (!r) continue;
            const node = vrm.humanoid.getNormalizedBoneNode(vrmKey); if (!node) continue;
            const base = new THREE.Quaternion(r.x, r.y, -r.z, -r.w).normalize();
            if (!isVrm0) base.set(base.x, -base.y, base.z, -base.w).normalize();
            const deg = corr[vk];
            if (deg) {
                const c = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(THREE.MathUtils.degToRad(deg), 0, 0));
                c.premultiply(base);
                node.quaternion.copy(c);
            } else {
                node.quaternion.copy(base);
            }
        }
        vrm.humanoid.update();
        return;
    }

    if (parsed.version === 2 && parsed.bones) {
        const q = new THREE.Quaternion();
        for (const [key, bd] of Object.entries(parsed.bones)) {
            const node = vrm.humanoid.getNormalizedBoneNode(key) ??
                         vrm.humanoid.getNormalizedBoneNode(key[0].toLowerCase() + key.slice(1));
            if (!node) continue;
            q.set(bd.qx, bd.qy, bd.qz, bd.qw);
            node.quaternion.copy(q);
        }
        vrm.humanoid.update();
        return;
    }

    const bones = parsed.bones ?? parsed;
    for (const [key, val] of Object.entries(bones)) {
        const node = vrm.humanoid.getNormalizedBoneNode(key) ??
                     vrm.humanoid.getNormalizedBoneNode(key[0].toLowerCase() + key.slice(1));
        if (!node) continue;
        node.rotation.x = val.x ?? 0;
        node.rotation.y = val.y ?? 0;
        node.rotation.z = val.z ?? 0;
    }
    vrm.humanoid.update();
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------
function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") e.style.cssText = v;
        else e[k] = v;
    }
    if (text !== undefined) e.textContent = text;
    return e;
}

function mkBtn(label, bg, title = "") {
    const btn = el("button", {
        style: `padding:5px 11px;background:${bg};color:#fff;border:none;` +
               "border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;" +
               "white-space:nowrap;transition:opacity 0.15s;",
    }, label);
    if (title) btn.title = title;
    btn.addEventListener("mouseenter", () => btn.style.opacity = "0.8");
    btn.addEventListener("mouseleave", () => btn.style.opacity = "1");
    return btn;
}
