// image_pose.js — Light & Pose Editor の「Image」タブ: 画像 → SAM 3D Body(ComfyUI ネイティブノード) → GLB → VRM ポーズ
//
// ライセンス上の方針: SAM 3D Body のコード・モデル重みはこのリポジトリに一切含めない。
// ComfyUI 本体(0.38 以降)に同梱のネイティブノード(SAM3DBody_Loader / SAM3DBody_Predict / BuildPoseFile / SaveGLB)を
// ComfyUI の HTTP API(/upload/image → /prompt → /history → /view)でワークフローとして実行し、
// 出力された GLB をバイト列として受け取って解析するだけにしている。モデルはユーザーが各自のライセンスに同意して導入する。

import { api } from "../../scripts/api.js";
import {
    classifyGlb, parseOpenposeGlb, parseMeshHands, samToPose,
    solvePose, defaultSolveOptions, captureRig, applySolvedPose,
} from "./image_pose_solver.js";

const REQUIRED_NODES = ["SAM3DBody_Loader", "SAM3DBody_Predict", "BuildPoseFile", "SaveGLB"];
const PREFERRED_MODEL = "sam_3d_body_dinov3_bf16.safetensors";

// ================================================================
// ComfyUI 実行
// ================================================================

async function getJson(path) {
    const res = await api.fetchApi(path);
    if (!res.ok) throw new Error(`ComfyUI ${path}: HTTP ${res.status}`);
    return res.json();
}

// object_info の COMBO 入力の選択肢(V1: [[...], {...}] / V3: ["COMBO", {options: [...]}] の両方に対応)
function comboOptions(spec) {
    if (!Array.isArray(spec)) return [];
    if (Array.isArray(spec[0])) return spec[0];
    return spec[1]?.options ?? [];
}

// ネイティブ SAM3D ノードの有無と、選べるモデルファイル一覧を返す
export async function checkSam3dAvailable() {
    const info = await getJson("/object_info");
    const missing = REQUIRED_NODES.filter(n => !info[n]);
    if (missing.length) {
        return { ok: false, models: [], message: `ComfyUI に SAM3D Body のネイティブノードがありません(${missing.join(", ")})。ComfyUI 0.38 以降に更新してください` };
    }
    const models = comboOptions(info.SAM3DBody_Loader?.input?.required?.model_file);
    if (!models.length) {
        return { ok: false, models, message: `SAM3D Body のモデルが見つかりません。models/detection/ に ${PREFERRED_MODEL} を置いてください` };
    }
    return { ok: true, models, message: "" };
}

function buildWorkflow(imageName, modelFile, prefix) {
    const buildPose = (format) => ({
        class_type: "BuildPoseFile",
        inputs: {
            pose_data: ["3", 0], ...format, fps: 24.0, camera_translation: "off", track_index: -1, sam3d_body_model: ["2", 0],
        },
    });
    return {
        1: { class_type: "LoadImage", inputs: { image: imageName } },
        2: { class_type: "SAM3DBody_Loader", inputs: { model_file: modelFile } },
        3: {
            class_type: "SAM3DBody_Predict",
            inputs: { sam3d_body_model: ["2", 0], image: ["1", 0], run_hand_refinement: true, fov: 0.0, batch_size: 64 },
        },
        // 3D 位置(骨名つきマーカー)。体の向きを解くのに使う
        4: buildPose({
            format: "glb", "format.mesh_style": "openpose", "format.mesh_style.marker_radius_m": 0.01,
            "format.mesh_style.stick_radius_m": 0.008, "format.mesh_style.include_hands": false,
            "format.mesh_style.hand_marker_radius_m": 0.005, "format.mesh_style.hand_stick_radius_m": 0.003,
            "format.mesh_style.face_style": "disabled", "format.mesh_style.face_marker_radius_m": 0.0,
            "format.bone_smooth_window": 0,
        }),
        // 人体メッシュ(MHR 骨格)。手首の向きと指の形を読むのに使う
        5: buildPose({
            format: "glb", "format.mesh_style": "body_mesh", "format.mesh_style.bone_vis": "off",
            "format.mesh_style.shader": "default", "format.bone_smooth_window": 0,
        }),
        6: { class_type: "SaveGLB", inputs: { mesh: ["4", 0], filename_prefix: `${prefix}_openpose` } },
        7: { class_type: "SaveGLB", inputs: { mesh: ["5", 0], filename_prefix: `${prefix}_mesh` } },
    };
}

async function downloadOutput(o) {
    const q = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder ?? "", type: o.type ?? "output" });
    const res = await api.fetchApi(`/view?${q}`);
    if (!res.ok) throw new Error(`ComfyUI の出力を取得できません: ${o.filename} (HTTP ${res.status})`);
    return res.arrayBuffer();
}

// 画像を ComfyUI に渡して SAM3D Body を実行し、openpose / body_mesh の 2 種類の GLB を受け取る
export async function runSam3d(imageBlob, imageExt, modelFile, onStatus, signal) {
    onStatus("画像を ComfyUI に送信中…");
    const form = new FormData();
    form.append("image", imageBlob, `vrmpose_sam_input.${imageExt || "png"}`);
    form.append("overwrite", "true");
    const up = await api.fetchApi("/upload/image", { method: "POST", body: form, signal });
    if (!up.ok) throw new Error(`ComfyUI への画像送信に失敗しました (HTTP ${up.status})`);
    const uploaded = await up.json();
    const imageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;

    const prefix = `3d/vrmpose_sam_${Date.now()}`;
    const res = await api.fetchApi("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: buildWorkflow(imageName, modelFile, prefix), client_id: api.clientId }),
        signal,
    });
    const submitted = await res.json().catch(() => ({}));
    if (!res.ok || !submitted.prompt_id) {
        const nodeErr = Object.values(submitted.node_errors ?? {})[0]?.errors?.[0];
        const detail = nodeErr ? `${nodeErr.message}: ${nodeErr.details ?? ""}` : (submitted.error?.message ?? `HTTP ${res.status}`);
        throw new Error(`ComfyUI がワークフローを受け付けませんでした: ${detail}`);
    }

    onStatus("SAM3D Body を実行中…(初回はモデル読み込みで数十秒かかることがあります)");
    const started = Date.now();
    for (;;) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        if (Date.now() - started > 10 * 60 * 1000) throw new Error("ComfyUI の実行が 10 分以内に終わりませんでした");
        await new Promise(r => setTimeout(r, 1000));
        const hist = await getJson(`/history/${submitted.prompt_id}`);
        const entry = hist[submitted.prompt_id];
        if (!entry) continue;
        if (entry.status?.status_str === "error") {
            const err = entry.status.messages?.find(m => m[0] === "execution_error")?.[1];
            throw new Error(`ComfyUI の実行エラー: ${String(err?.exception_message ?? "不明")}`);
        }
        const op = entry.outputs?.["6"]?.["3d"]?.[0];
        const mesh = entry.outputs?.["7"]?.["3d"]?.[0];
        if (op && mesh) {
            onStatus("結果を取得中…");
            const [openpose, meshBuf] = await Promise.all([downloadOutput(op), downloadOutput(mesh)]);
            return { openpose, mesh: meshBuf };
        }
        if (entry.status?.completed) throw new Error("ComfyUI の実行は終わりましたが GLB が出力されませんでした(人物が検出されなかった可能性があります)");
    }
}

// ================================================================
// Image タブ UI
// ================================================================
// editor._imagePoseState にタブの状態(画像・SAM3D 結果・オプション)を保持し、モーダルを閉じて開き直しても残す。

function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") e.style.cssText = v;
        else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
}

function mkBtn(label, bg) {
    return el("button", {
        style: `padding:4px 9px;background:${bg};color:#fff;border:none;border-radius:4px;` +
               "cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;",
    }, label);
}

function sectionTitle(t) {
    return el("div", {
        style: "font-size:10px;font-weight:bold;color:#6a8a9a;margin:8px 0 3px;" +
               "border-bottom:1px solid #252535;padding-bottom:2px;letter-spacing:.4px;",
    }, t.toUpperCase());
}

function mkCheck(label, checked, title) {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    const row = el("label", { style: "display:flex;align-items:center;gap:6px;font-size:11px;color:#bbb;padding:2px 0;cursor:pointer;" });
    if (title) row.title = title;
    row.append(input, label);
    return [row, input];
}

function mkSlider(label, min, max, step, value, fmt) {
    const input = el("input", {
        type: "range", min: String(min), max: String(max), step: String(step), value: String(value),
        style: "flex:1;min-width:0;height:12px;accent-color:#4a90d9;cursor:pointer;",
    });
    input.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    const val = el("span", { style: "font-size:10px;color:#888;width:34px;text-align:right;flex-shrink:0;" }, fmt(value));
    input.addEventListener("input", () => { val.textContent = fmt(parseFloat(input.value)); });
    const row = el("div", { style: "display:flex;align-items:center;gap:6px;padding:2px 0;" });
    row.append(el("span", { style: "font-size:10px;color:#888;width:64px;flex-shrink:0;" }, label), input, val);
    return [row, input];
}

// 戻り値: { leftEl, propEl, onShow }
//   leftEl: 左ペイン(270px、画像の読み込み・表示)
//   propEl: 右ペイン(280px、SAM3D 実行・オプション・適用)
//   onShow: Image タブが表示されるたびに呼ぶ(ComfyUI のノード/モデル確認)
export function buildImagePosePanel(editor) {
    const state = editor._imagePoseState ??= {
        imageFile: null,     // File | Blob
        imageUrl: null,      // object URL(プレビュー用)
        imageName: "",
        sam: null,           // parseOpenposeGlb の結果
        hands: null,         // parseMeshHands の結果
        source: "",          // 結果の出どころ(表示用)
        model: "",
        opts: { ...defaultSolveOptions, useHands: true, ground: true },
        undoPose: null,      // 最初に適用する直前のポーズ(exportPose JSON)
        undoVrm: null,       // undoPose を取ったときの VRM
    };

    // ---------------- 左ペイン: 画像 ----------------
    const leftEl = el("div", {
        style: "width:270px;flex-shrink:0;display:none;flex-direction:column;" +
               "border-right:1px solid #2a2a4a;background:#161622;overflow:hidden;",
    });
    const leftHeader = el("div", {
        style: "display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    });
    const loadImgBtn = mkBtn("📂 Load Image", "#2a5a8a");
    const imgInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", style: "display:none;" });
    loadImgBtn.onclick = () => imgInput.click();
    leftHeader.append(el("span", { style: "font-size:12px;font-weight:bold;color:#aaa;flex:1;" }, "Image"), loadImgBtn, imgInput);

    const dropZone = el("div", {
        style: "flex:1;margin:8px;border:2px dashed #33334a;border-radius:6px;display:flex;align-items:center;" +
               "justify-content:center;overflow:hidden;min-height:0;position:relative;background:#12121c;",
    });
    const placeholder = el("div", {
        style: "font-size:11px;color:#556;text-align:center;line-height:1.7;padding:10px;",
    }, "画像をドロップ\nまたは「Load Image」");
    placeholder.style.whiteSpace = "pre-line";
    const preview = el("img", { style: "max-width:100%;max-height:100%;object-fit:contain;display:none;" });
    dropZone.append(placeholder, preview);
    const imgInfo = el("div", {
        style: "font-size:10px;color:#778;padding:0 10px 8px;word-break:break-all;flex-shrink:0;",
    });
    const tips = el("div", {
        style: "font-size:10px;color:#556;padding:0 10px 10px;line-height:1.6;flex-shrink:0;",
    }, "1人・全身が写り、手足が隠れていない画像が最適です。自撮りなど左右反転した画像は「Mirror」をオンにしてください。");
    leftEl.append(leftHeader, dropZone, imgInfo, tips);

    function setImage(file) {
        if (!file || !file.type?.startsWith("image/")) return;
        if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
        state.imageFile = file;
        state.imageName = file.name ?? "image";
        state.imageUrl = URL.createObjectURL(file);
        // 別の画像に変えたら、前の画像の SAM3D 結果は無効
        state.sam = null;
        state.hands = null;
        state.source = "";
        refreshImage();
        refreshStatus();
    }
    function refreshImage() {
        const has = !!state.imageUrl;
        preview.style.display = has ? "" : "none";
        placeholder.style.display = has ? "none" : "";
        if (has) preview.src = state.imageUrl;
        imgInfo.textContent = has ? state.imageName : "";
        runBtn.disabled = !has || busy;
        runBtn.style.opacity = runBtn.disabled ? "0.5" : "1";
    }
    imgInput.addEventListener("change", () => { setImage(imgInput.files[0]); imgInput.value = ""; });
    dropZone.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = "#4a90d9"; });
    dropZone.addEventListener("dragleave", () => { dropZone.style.borderColor = "#33334a"; });
    dropZone.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation();
        dropZone.style.borderColor = "#33334a";
        const files = [...(e.dataTransfer?.files ?? [])];
        const img = files.find(f => f.type.startsWith("image/"));
        if (img) setImage(img);
        const glbs = files.filter(f => /\.glb$/i.test(f.name));
        if (glbs.length) void loadGlbFiles(glbs);
    });

    // ---------------- 右ペイン: SAM3D・オプション ----------------
    const propEl = el("div", {
        style: "width:280px;flex-shrink:0;display:none;flex-direction:column;background:#181826;",
    });
    propEl.append(el("div", {
        style: "font-size:11px;font-weight:bold;color:#7a9aaa;padding:7px 12px;border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    }, "Image → Pose (SAM 3D Body)"));
    const propBody = el("div", { style: "flex:1;overflow-y:auto;padding:6px 12px 10px;" });
    propEl.append(propBody);

    // SAM3D 実行
    const modelSel = el("select", {
        style: "flex:1;min-width:0;background:#222;color:#ccc;border:1px solid #444;border-radius:3px;font-size:10px;padding:2px;",
    });
    modelSel.addEventListener("change", () => { state.model = modelSel.value; });
    const runBtn = mkBtn("▶ Run SAM3D", "#3a7a4a");
    runBtn.style.flex = "1";
    const cancelBtn = mkBtn("■", "#6a3a3a");
    cancelBtn.title = "Cancel (結果の待機を中止)";
    cancelBtn.style.display = "none";
    const statusEl = el("div", {
        style: "font-size:10px;color:#889;padding:4px 0;line-height:1.5;white-space:pre-wrap;word-break:break-word;",
    });

    // 手動 GLB 読み込み(ComfyUI で別途作った openpose / body_mesh の GLB)
    const glbBtn = mkBtn("📂 Load GLB", "#5a5a7a");
    glbBtn.title = "SAM3D の GLB(BuildPoseFile → SaveGLB、mesh_style=openpose / body_mesh)を読み込む。複数選択可";
    const glbInput = el("input", { type: "file", accept: ".glb", multiple: "", style: "display:none;" });
    glbBtn.onclick = () => glbInput.click();
    glbInput.addEventListener("change", () => { void loadGlbFiles([...glbInput.files]); glbInput.value = ""; });

    // オプション
    const o = state.opts;
    const [mirrorRow, mirrorChk] = mkCheck("Mirror (鏡像として扱う)", o.mirror, "自撮りなど左右反転した画像のとき");
    const [handsRow, handsChk] = mkCheck("Hands (SAM3D の指・手首を使う)", o.useHands, "body_mesh の手の骨から指の形と手首の向きを取り込む");
    const [fingersRow, fingersChk] = mkCheck("Fingers (指を解く)", o.fingers);
    const [yawRow, yawChk] = mkCheck("Face front (体の向きを正面に)", o.removeYaw, "カメラに対する体全体のヨーを除去する");
    const [groundRow, groundChk] = mkCheck("Ground (足を床に合わせる)", o.ground);
    const [headRow, headSl] = mkSlider("Head pitch", -30, 45, 1, o.headPitchDeg, v => `${v}°`);
    const [twistRow, twistSl] = mkSlider("Wrist twist", 0, 1, 0.05, o.twistSplit, v => v.toFixed(2));
    twistRow.title = "手首のねじれを前腕に分配する割合";

    const applyBtn = mkBtn("✔ Apply to VRM", "#4a6a9a");
    applyBtn.style.flex = "1";
    const revertBtn = mkBtn("↶ Revert", "#6a5a3a");
    revertBtn.title = "Image タブで最初に適用する前のポーズへ戻す";

    const row = (...items) => {
        const r = el("div", { style: "display:flex;align-items:center;gap:5px;padding:2px 0;" });
        r.append(...items);
        return r;
    };
    propBody.append(
        sectionTitle("SAM 3D Body (ComfyUI)"),
        row(el("span", { style: "font-size:10px;color:#888;flex-shrink:0;" }, "Model"), modelSel),
        row(runBtn, cancelBtn),
        row(glbBtn, glbInput),
        statusEl,
        sectionTitle("Options"),
        mirrorRow, handsRow, fingersRow, yawRow, groundRow, headRow, twistRow,
        sectionTitle("Apply"),
        row(applyBtn, revertBtn),
        el("div", {
            style: "font-size:10px;color:#556;line-height:1.6;margin-top:8px;",
        }, "SAM 3D Body は ComfyUI 本体のネイティブノードで実行します(このノードには同梱していません)。モデルは models/detection/ に配置してください。適用後は Pose タブやキーフレームでそのまま微調整・保存できます。"),
    );

    // ---------------- 動作 ----------------
    let busy = false;
    let abort = null;
    let lastMessage = "";

    function setStatus(msg, kind) {
        lastMessage = msg;
        statusEl.textContent = msg;
        statusEl.style.color = kind === "error" ? "#e88" : kind === "ok" ? "#8c8" : "#889";
    }
    function refreshStatus() {
        const has = !!state.sam;
        applyBtn.disabled = !has;
        applyBtn.style.opacity = has ? "1" : "0.5";
        revertBtn.disabled = !state.undoPose;
        revertBtn.style.opacity = state.undoPose ? "1" : "0.5";
        if (!busy && !lastMessage) {
            setStatus(has ? `結果あり: ${state.source}` : "画像を読み込んで「Run SAM3D」を押してください");
        }
    }
    function setBusy(b) {
        busy = b;
        cancelBtn.style.display = b ? "" : "none";
        glbBtn.disabled = b;
        refreshImage();
    }

    function readOpts() {
        o.mirror = mirrorChk.checked;
        o.useHands = handsChk.checked;
        o.fingers = fingersChk.checked;
        o.removeYaw = yawChk.checked;
        o.ground = groundChk.checked;
        o.headPitchDeg = parseFloat(headSl.value);
        o.twistSplit = parseFloat(twistSl.value);
        return o;
    }

    // SAM3D 結果 → ソルブ → VRM へ適用
    function solveAndApply(silent) {
        if (!state.sam) return false;
        const vrm = editor.getVRM?.();
        if (!vrm?.humanoid) {
            setStatus("VRM モデル(humanoid 付き)を読み込んでください。GLB/GLTF モデルには適用できません", "error");
            return false;
        }
        const opt = readOpts();
        const hands = opt.useHands ? state.hands : null;
        const input = {
            pose: samToPose(state.sam, hands),
            leftHand: hands?.left, rightHand: hands?.right,
            leftHandSide: hands?.leftSide, rightHandSide: hands?.rightSide,
        };
        const rig = captureRig(vrm);
        // Revert 用のポーズは同じモデルに対してだけ有効(モデルを差し替えたら取り直す)
        if (state.undoVrm !== vrm) { state.undoPose = null; state.undoVrm = vrm; }
        if (!state.undoPose) state.undoPose = editor.exportPose();
        const res = solvePose(input, rig, opt);
        applySolvedPose(editor, vrm, rig, res.rotations, opt.ground);
        refreshStatus();
        if (!silent) {
            const sk = res.skipped.length ? `\n(推定できず: ${res.skipped.join(", ")})` : "";
            setStatus(`VRM に適用しました: ${state.source}${sk}`, "ok");
        }
        return true;
    }

    // オプションを変えたら、結果があれば即再適用
    for (const c of [mirrorChk, handsChk, fingersChk, yawChk, groundChk]) {
        c.addEventListener("change", () => { readOpts(); if (state.sam) solveAndApply(true); });
    }
    for (const s of [headSl, twistSl]) {
        s.addEventListener("change", () => { readOpts(); if (state.sam) solveAndApply(true); });
    }

    applyBtn.onclick = () => solveAndApply(false);
    revertBtn.onclick = () => {
        if (!state.undoPose) return;
        if (state.undoVrm !== editor.getVRM?.()) {
            state.undoPose = null;
            setStatus("モデルが変わったため、戻すポーズがありません");
            refreshStatus();
            return;
        }
        editor.importPose(state.undoPose);
        state.undoPose = null;
        setStatus("適用前のポーズに戻しました");
        refreshStatus();
    };

    async function applyGlbBuffer(buf, name) {
        const kind = classifyGlb(buf);
        if (kind === "openpose") {
            state.sam = parseOpenposeGlb(buf);
            state.source = name;
        } else if (kind === "mesh") {
            state.hands = parseMeshHands(buf);
        } else {
            throw new Error(`${name}: SAM3D Body の GLB ではありません(format=glb、mesh_style は openpose か body_mesh)`);
        }
        return kind;
    }

    async function loadGlbFiles(files) {
        try {
            // body_mesh(手)を先に読み、openpose(体)を後に読んでから適用する
            const bufs = await Promise.all(files.map(async f => ({ name: f.name, buf: await f.arrayBuffer() })));
            const rank = x => (classifyGlb(x.buf) === "mesh" ? 0 : 1);
            bufs.sort((a, b) => rank(a) - rank(b));
            const kinds = [];
            for (const { name, buf } of bufs) kinds.push(await applyGlbBuffer(buf, name));
            if (state.sam) {
                if (solveAndApply(true)) setStatus(`GLB を読み込んで適用しました(${kinds.join(" + ")})`, "ok");
            } else {
                setStatus("body_mesh の GLB を読み込みました。体の向きには openpose の GLB も必要です");
            }
        } catch (e) {
            setStatus(String(e.message ?? e), "error");
        }
        refreshStatus();
    }

    runBtn.onclick = async () => {
        if (busy || !state.imageFile) return;
        if (!editor.getVRM?.()?.humanoid) {
            setStatus("先に VRM モデルを読み込んでください", "error");
            return;
        }
        const modelFile = modelSel.value;
        if (!modelFile) { await refreshAvailability(); if (!modelSel.value) return; }
        setBusy(true);
        abort = new AbortController();
        const t0 = performance.now();
        try {
            const ext = (state.imageName.split(".").pop() ?? "png").toLowerCase();
            const r = await runSam3d(state.imageFile, ext, modelSel.value, msg => setStatus(msg), abort.signal);
            state.hands = parseMeshHands(r.mesh);
            state.sam = parseOpenposeGlb(r.openpose);
            state.source = `SAM3D (${state.imageName})`;
            solveAndApply(true);
            setStatus(`SAM3D 推定・適用完了(${((performance.now() - t0) / 1000).toFixed(1)} 秒)`, "ok");
        } catch (e) {
            if (e?.name === "AbortError") setStatus("中止しました(ComfyUI のキューに残ったジョブは ComfyUI 側で取り消してください)");
            else setStatus(String(e.message ?? e), "error");
        } finally {
            abort = null;
            setBusy(false);
            refreshStatus();
        }
    };
    cancelBtn.onclick = () => abort?.abort();

    let availabilityChecked = false;
    async function refreshAvailability() {
        try {
            const r = await checkSam3dAvailable();
            modelSel.replaceChildren(...r.models.map(m => el("option", { value: m }, m)));
            const pick = r.models.includes(state.model) ? state.model
                : r.models.includes(PREFERRED_MODEL) ? PREFERRED_MODEL
                : r.models.find(m => /sam_3d_body|sam3d/i.test(m)) ?? r.models[0] ?? "";
            modelSel.value = pick;
            state.model = pick;
            if (!r.ok) setStatus(r.message, "error");
            availabilityChecked = r.ok;
        } catch (e) {
            setStatus(`ComfyUI のノード情報を取得できません: ${e.message ?? e}`, "error");
        }
    }

    refreshImage();
    refreshStatus();

    return {
        leftEl,
        propEl,
        onShow() {
            if (!availabilityChecked) void refreshAvailability();
        },
    };
}
