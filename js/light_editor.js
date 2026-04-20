/**
 * Light Editor Panel
 * - Embeds the actual WebGL canvas (cvsWrapper) into the preview panel via DOM move + CSS scale
 *   → bone operations, camera orbit, light helper drag all work natively
 * - Multiple lights: Directional(Sun), Point, Spot, RectArea(Box), Ambient
 * - Per-light: color, intensity, position XYZ, target XYZ, angle, shadow (Directional only)
 * - Ground height (Y) / Background wall depth (Z) sliders
 * - Shadow quality selector
 */

export function openLightEditor(editor, cvsWrapper) {
    if (document.getElementById("light-editor-modal")) return;
    document.body.appendChild(buildModal(editor, cvsWrapper));
}

// ----------------------------------------------------------------
const LIGHT_TYPES = [
    { value: "directional", label: "☀ Sun (Directional)" },
    { value: "point",       label: "💡 Point" },
    { value: "spot",        label: "🔦 Spot" },
    { value: "rect",        label: "▭ Box (Rect Area)" },
    { value: "ambient",     label: "🌐 Ambient" },
];

function buildModal(editor, cvsWrapper) {
    // ---- Save original DOM position of cvsWrapper ----
    const origParent      = cvsWrapper.parentNode;
    const origNextSibling = cvsWrapper.nextSibling;
    const origTransform   = cvsWrapper.style.transform;
    const origTransformOrigin = cvsWrapper.style.transformOrigin;
    const origPosition    = cvsWrapper.style.position;

    // Overlay
    const overlay = el("div", {
        id: "light-editor-modal",
        style: "position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:99999;" +
               "display:flex;align-items:center;justify-content:center;",
    });
    overlay.tabIndex = -1;
    overlay.addEventListener("keydown", e => { if (e.key === "Escape") cleanup(); });
    overlay.addEventListener("click",   e => { if (e.target === overlay) cleanup(); });
    overlay.focus();

    let resizeObserver = null;

    function cleanup() {
        // Restore cvsWrapper
        cvsWrapper.style.transform       = origTransform;
        cvsWrapper.style.transformOrigin = origTransformOrigin;
        cvsWrapper.style.position        = origPosition;
        if (origNextSibling) origParent.insertBefore(cvsWrapper, origNextSibling);
        else                  origParent.appendChild(cvsWrapper);

        resizeObserver?.disconnect();
        editor.clearLightHelpers();
        window.removeEventListener("lightHelperMoved", onHelperMoved);
        overlay.remove();
    }

    // ---- Dialog ----
    const dialog = el("div", {
        style: "background:#1e1e2e;color:#ccc;border-radius:10px;" +
               "width:min(96vw,1120px);height:min(94vh,700px);display:flex;flex-direction:column;" +
               "box-shadow:0 8px 40px rgba(0,0,0,0.85);overflow:hidden;font-family:sans-serif;",
    });

    // ---- Header ----
    const header = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:10px 14px;" +
               "background:#16213e;border-bottom:1px solid #333;flex-shrink:0;",
    });
    header.append(
        el("span", { style: "font-size:15px;font-weight:bold;color:#e0e0ff;flex:1;" }, "💡 Light Editor"),
        mkCloseBtn(cleanup)
    );

    // ---- Scene options bar ----
    const sceneBar = el("div", {
        style: "display:flex;align-items:center;gap:10px;padding:6px 14px;" +
               "background:#1a1a2e;border-bottom:1px solid #2a2a4a;flex-shrink:0;flex-wrap:wrap;",
    });

    const groundBtn = mkToggleBtn("🟫 Ground", editor.getGroundVisible());
    groundBtn.onclick = () => applyToggle(groundBtn, "🟫 Ground", editor.toggleGround());

    const groundYLbl = el("span", { style: "font-size:10px;color:#888;" }, "Y:");
    const [groundYSl, groundYVl] = mkSl(-5, 5, 0.01, editor.getGroundY(), v => editor.setGroundY(v));
    groundYSl.style.cssText += ";width:70px;flex:none;";

    const bgWallBtn = mkToggleBtn("🖼 BG Wall", editor.getBgWallVisible());
    bgWallBtn.onclick = () => applyToggle(bgWallBtn, "🖼 BG Wall", editor.toggleBgWall());

    const bgZLbl = el("span", { style: "font-size:10px;color:#888;" }, "Z:");
    const [bgZSl, bgZVl] = mkSl(-20, 5, 0.01, editor.getBgWallZ(), v => editor.setBgWallZ(v));
    bgZSl.style.cssText += ";width:70px;flex:none;";

    const shadowLbl = el("span", { style: "font-size:10px;color:#888;margin-left:6px;" }, "Shadow:");
    const shadowSel = el("select", {
        style: "background:#111;border:1px solid #444;color:#ddd;padding:3px 6px;" +
               "border-radius:4px;font-size:11px;cursor:pointer;",
    });
    [["none","None"],["soft","Soft PCF"],["hard","Hard"]].forEach(([v, t]) =>
        shadowSel.appendChild(el("option", { value: v }, t)));
    shadowSel.value = "soft";
    shadowSel.addEventListener("change", () => editor.setShadowQuality(shadowSel.value));
    shadowSel.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

    sceneBar.append(
        groundBtn, groundYLbl, groundYSl, groundYVl,
        sep(), bgWallBtn, bgZLbl, bgZSl, bgZVl,
        shadowLbl, shadowSel
    );

    // ---- Surface bar (color / texture) ----
    const surfaceBar = el("div", {
        style: "display:flex;align-items:center;gap:8px;padding:5px 14px;" +
               "background:#16162a;border-bottom:1px solid #2a2a4a;flex-shrink:0;flex-wrap:wrap;",
    });

    // ---- Ground surface ----
    surfaceBar.appendChild(el("span", { style: "font-size:10px;color:#777;white-space:nowrap;" }, "🟫 Ground:"));

    const groundColorPick = el("input", { type: "color", value: editor.getGroundColor(),
        style: "width:28px;height:22px;border:none;cursor:pointer;background:none;padding:0;flex-shrink:0;",
        title: "Ground color" });
    groundColorPick.addEventListener("input", () => editor.setGroundColor(groundColorPick.value));
    surfaceBar.appendChild(groundColorPick);

    const groundTexBtn = mkBtn("📁 Tex", "#2a4a6a"); groundTexBtn.title = "Load ground texture";
    groundTexBtn.style.padding = "3px 8px";
    const groundTexInput = mkFileInput("image/*");
    groundTexInput.addEventListener("change", e => {
        const file = e.target.files[0]; if (!file) return;
        const url = URL.createObjectURL(file);
        editor.setGroundTexture(url);
        groundTexBtn.textContent = "📁 " + file.name.slice(0, 14) + (file.name.length > 14 ? "…" : "");
        groundTexBtn.style.background = "#2a6a4a";
        groundTexInput.value = "";
    });
    groundTexBtn.onclick = () => groundTexInput.click();
    surfaceBar.append(groundTexBtn, groundTexInput);

    const groundTexClear = mkBtn("✕", "#5a3a3a"); groundTexClear.title = "Clear texture";
    groundTexClear.style.padding = "3px 7px";
    groundTexClear.onclick = () => {
        editor.clearGroundTexture();
        groundTexBtn.textContent = "📁 Tex"; groundTexBtn.style.background = "#2a4a6a";
    };
    surfaceBar.appendChild(groundTexClear);

    const groundTileLbl = el("span", { style: "font-size:10px;color:#777;" }, "Tile:");
    const groundTileNum = mkNumInput(0.1, 50, 0.1, 1, n => editor.setGroundTexRepeat(n));
    surfaceBar.append(groundTileLbl, groundTileNum);

    surfaceBar.appendChild(sep());
    const groundSCBtn = mkToggleBtn("🕶 SC", editor.getGroundShadowCatcher());
    groundSCBtn.style.padding = "3px 9px";
    groundSCBtn.title = "Shadow Catcher: 面を透明にして影だけ表示";
    groundSCBtn.onclick = () => applyToggle(groundSCBtn, "🕶 SC", editor.toggleGroundShadowCatcher());
    const groundSCOpLbl = el("span", { style: "font-size:10px;color:#777;" }, "影濃度:");
    const groundSCOpNum = mkNumInput(0.01, 1, 0.05, 0.5, v => editor.setGroundShadowOpacity(v));
    surfaceBar.append(groundSCBtn, groundSCOpLbl, groundSCOpNum);

    surfaceBar.appendChild(sep());

    // ---- BG Wall surface ----
    surfaceBar.appendChild(el("span", { style: "font-size:10px;color:#777;white-space:nowrap;" }, "🖼 Wall:"));

    const wallColorPick = el("input", { type: "color", value: editor.getBgWallColor(),
        style: "width:28px;height:22px;border:none;cursor:pointer;background:none;padding:0;flex-shrink:0;",
        title: "Wall color" });
    wallColorPick.addEventListener("input", () => editor.setBgWallColor(wallColorPick.value));
    surfaceBar.appendChild(wallColorPick);

    const wallTexBtn = mkBtn("📁 Tex", "#2a4a6a"); wallTexBtn.title = "Load wall texture";
    wallTexBtn.style.padding = "3px 8px";
    const wallTexInput = mkFileInput("image/*");
    wallTexInput.addEventListener("change", e => {
        const file = e.target.files[0]; if (!file) return;
        const url = URL.createObjectURL(file);
        editor.setBgWallTexture(url);
        wallTexBtn.textContent = "📁 " + file.name.slice(0, 14) + (file.name.length > 14 ? "…" : "");
        wallTexBtn.style.background = "#2a6a4a";
        wallTexInput.value = "";
    });
    wallTexBtn.onclick = () => wallTexInput.click();
    surfaceBar.append(wallTexBtn, wallTexInput);

    const wallTexClear = mkBtn("✕", "#5a3a3a"); wallTexClear.title = "Clear texture";
    wallTexClear.style.padding = "3px 7px";
    wallTexClear.onclick = () => {
        editor.clearBgWallTexture();
        wallTexBtn.textContent = "📁 Tex"; wallTexBtn.style.background = "#2a4a6a";
    };
    surfaceBar.appendChild(wallTexClear);

    const wallTileLbl = el("span", { style: "font-size:10px;color:#777;" }, "Tile:");
    const wallTileNum = mkNumInput(0.1, 50, 0.1, 1, n => editor.setBgWallTexRepeat(n));
    surfaceBar.append(wallTileLbl, wallTileNum);

    surfaceBar.appendChild(sep());
    const wallSCBtn = mkToggleBtn("🕶 SC", editor.getBgWallShadowCatcher());
    wallSCBtn.style.padding = "3px 9px";
    wallSCBtn.title = "Shadow Catcher: 面を透明にして影だけ表示";
    wallSCBtn.onclick = () => applyToggle(wallSCBtn, "🕶 SC", editor.toggleBgWallShadowCatcher());
    const wallSCOpLbl = el("span", { style: "font-size:10px;color:#777;" }, "影濃度:");
    const wallSCOpNum = mkNumInput(0.01, 1, 0.05, 0.5, v => editor.setBgWallShadowOpacity(v));
    surfaceBar.append(wallSCBtn, wallSCOpLbl, wallSCOpNum);

    // ---- 3-column body ----
    const body = el("div", { style: "flex:1;display:flex;overflow:hidden;min-height:0;" });

    // ---- Col 1: Light list ----
    const listPanel = el("div", {
        style: "width:185px;flex-shrink:0;display:flex;flex-direction:column;" +
               "border-right:1px solid #2a2a4a;background:#161622;",
    });
    const listHeader = el("div", {
        style: "display:flex;align-items:center;padding:7px 10px;" +
               "border-bottom:1px solid #2a2a4a;flex-shrink:0;",
    });
    const addBtn = mkBtn("＋ Add", "#2a5a8a");
    addBtn.style.padding = "3px 9px";
    listHeader.append(
        el("span", { style: "font-size:12px;font-weight:bold;color:#aaa;flex:1;" }, "Lights"),
        addBtn
    );
    const listContent = el("div", { style: "flex:1;overflow-y:auto;padding:4px;" });
    listPanel.append(listHeader, listContent);

    // ---- Col 2: Preview (actual WebGL canvas embedded) ----
    const previewPanel = el("div", {
        style: "flex:1;display:flex;flex-direction:column;background:#111118;" +
               "border-right:1px solid #2a2a4a;min-width:0;",
    });
    const previewHeader = el("div", {
        style: "font-size:10px;color:#556;padding:5px 10px;flex-shrink:0;" +
               "border-bottom:1px solid #1a1a2a;background:#13131e;",
    }, "🎥 Preview  ·  ドラッグでカメラ操作  ·  青球でボーン操作  ·  黄球でライト移動");

    // Container that will hold cvsWrapper
    const previewWrap = el("div", {
        style: "flex:1;display:flex;align-items:center;justify-content:center;" +
               "overflow:hidden;min-height:0;padding:4px;",
    });
    previewPanel.append(previewHeader, previewWrap);

    // ---- Col 3: Properties ----
    const propPanel = el("div", {
        style: "width:280px;flex-shrink:0;display:flex;flex-direction:column;background:#181826;",
    });
    propPanel.append(
        el("div", {
            style: "font-size:11px;font-weight:bold;color:#7a9aaa;padding:7px 12px;" +
                   "border-bottom:1px solid #2a2a4a;flex-shrink:0;",
        }, "Properties")
    );
    const propBody = el("div", { style: "flex:1;overflow-y:auto;padding:10px 12px;" });
    propPanel.appendChild(propBody);

    body.append(listPanel, previewPanel, propPanel);
    dialog.append(header, sceneBar, surfaceBar, body);
    overlay.appendChild(dialog);

    // ---- Embed cvsWrapper into preview ----
    previewWrap.appendChild(cvsWrapper);
    cvsWrapper.style.position = "relative"; // override absolute if any

    function applyScale() {
        const pw = previewWrap.clientWidth  - 8;
        const ph = previewWrap.clientHeight - 8;
        if (pw <= 0 || ph <= 0) return;
        // cvsWrapper is 384×384 in layout
        const scale = Math.min(pw / 384, ph / 384);
        cvsWrapper.style.transform       = `scale(${scale.toFixed(4)})`;
        cvsWrapper.style.transformOrigin = "center center";
    }
    // Apply after first layout paint
    requestAnimationFrame(() => {
        applyScale();
        resizeObserver = new ResizeObserver(applyScale);
        resizeObserver.observe(previewWrap);
    });

    // ----------------------------------------------------------------
    // State
    // ----------------------------------------------------------------
    let selectedId   = null;
    let lightCounter = 0;

    // ---- Light list ----
    function refreshList() {
        listContent.innerHTML = "";
        const lights = editor.getLights();
        if (lights.length === 0) {
            listContent.appendChild(el("div", {
                style: "font-size:11px;color:#555;padding:10px;text-align:center;",
            }, "No lights.\nClick ＋ Add."));
            return;
        }
        lights.forEach(cfg => {
            const isSel = selectedId === cfg.id;
            const item = el("div", {
                style: "display:flex;align-items:center;gap:5px;padding:6px 8px;" +
                       "border-radius:5px;cursor:pointer;margin-bottom:2px;" +
                       `background:${isSel ? "#222d45" : "#1c1c2c"};` +
                       `border:1px solid ${isSel ? "#4a6aaa" : "transparent"};`,
            });
            const icon = { directional:"☀", point:"💡", spot:"🔦", rect:"▭", ambient:"🌐" }[cfg.type] ?? "?";
            item.append(
                el("span", {
                    style: "flex:1;font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                }, `${icon} ${cfg.name}`),
                mkDot(cfg, () => { editor.setLightEnabled(cfg.id, !cfg.enabled); refreshList(); if (selectedId === cfg.id) showProps(cfg.id); }),
                mkDel(() => { editor.removeLight(cfg.id); if (selectedId === cfg.id) { selectedId = null; showProps(null); } refreshList(); })
            );
            item.addEventListener("click", () => {
                selectedId = cfg.id; refreshList(); showProps(cfg.id); editor.selectLightHelper(cfg.id);
            });
            listContent.appendChild(item);
        });
    }

    // ---- Properties ----
    function showProps(id) {
        propBody.innerHTML = "";
        if (id === null) {
            propBody.appendChild(el("div", { style: "color:#555;font-size:12px;padding:20px 0;text-align:center;" },
                "Select a light to edit"));
            return;
        }
        const cfg = editor.getLights().find(l => l.id === id);
        if (!cfg) { showProps(null); return; }

        function sec(t) {
            propBody.appendChild(el("div", {
                style: "font-size:10px;font-weight:bold;color:#6a8a9a;margin:10px 0 5px;" +
                       "border-bottom:1px solid #252535;padding-bottom:2px;letter-spacing:.4px;",
            }, t.toUpperCase()));
        }
        function row(label, ctrl) {
            const r = el("div", { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;" });
            r.append(el("label", { style: "font-size:11px;color:#888;width:82px;flex-shrink:0;text-align:right;" }, label), ctrl);
            propBody.appendChild(r);
            return r;
        }
        function appendLast(node) { propBody.lastChild.appendChild(node); }

        // Identity
        sec("Identity");
        const nameIn = mkText(cfg.name);
        nameIn.addEventListener("change", () => { editor.updateLight(id, { name: nameIn.value }); refreshList(); });
        row("Name:", nameIn);

        const typeSel = el("select", {
            style: "flex:1;background:#111;border:1px solid #444;color:#ddd;padding:4px 6px;" +
                   "border-radius:4px;font-size:12px;cursor:pointer;",
        });
        LIGHT_TYPES.forEach(({ value, label }) => typeSel.appendChild(el("option", { value }, label)));
        typeSel.value = cfg.type;
        typeSel.addEventListener("change", () => { editor.updateLight(id, { type: typeSel.value }); showProps(id); refreshList(); });
        typeSel.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
        row("Type:", typeSel);

        // Color & Intensity
        sec("Color & Intensity");
        const colorPick = el("input", { type: "color", value: cfg.color,
            style: "width:34px;height:24px;border:none;cursor:pointer;background:none;padding:0;flex-shrink:0;" });
        const hexIn = mkText(cfg.color, "68px");
        colorPick.addEventListener("input", () => { hexIn.value = colorPick.value; editor.updateLight(id, { color: colorPick.value }); refreshList(); });
        hexIn.addEventListener("change", () => {
            if (/^#[0-9a-f]{6}$/i.test(hexIn.value)) { colorPick.value = hexIn.value; editor.updateLight(id, { color: hexIn.value }); refreshList(); }
        });
        const cw = el("div", { style: "display:flex;align-items:center;gap:5px;flex:1;" });
        cw.append(colorPick, hexIn);
        row("Color:", cw);

        const [iSl, iVl] = mkSl(0, 20, 0.1, cfg.intensity, v => editor.updateLight(id, { intensity: v }));
        row("Intensity:", iSl); appendLast(iVl);

        // Position
        if (cfg.type !== "ambient") {
            sec("Position  (黄球をドラッグで3D移動)");
            ["x","y","z"].forEach(axis => {
                const [sl, vl] = mkSl(-20, 20, 0.1, cfg.position[axis], v => {
                    cfg.position = { ...cfg.position, [axis]: v };
                    editor.updateLight(id, { position: { ...cfg.position } });
                });
                row("Pos " + axis.toUpperCase() + ":", sl); appendLast(vl);
            });
        }

        // Target
        if (cfg.type === "directional" || cfg.type === "spot") {
            sec("Target");
            ["x","y","z"].forEach(axis => {
                const [sl, vl] = mkSl(-20, 20, 0.1, cfg.target[axis], v => {
                    cfg.target = { ...cfg.target, [axis]: v };
                    editor.updateLight(id, { target: { ...cfg.target } });
                });
                row("Target " + axis.toUpperCase() + ":", sl); appendLast(vl);
            });
        }

        // Spot params
        if (cfg.type === "spot") {
            sec("Spot");
            const [aSl, aVl] = mkSl(0, Math.PI / 2, 0.01, cfg.angle ?? Math.PI / 6,
                v => editor.updateLight(id, { angle: v }),
                v => (v * 180 / Math.PI).toFixed(0) + "°");
            row("Angle:", aSl); appendLast(aVl);
            const [pSl, pVl] = mkSl(0, 1, 0.01, cfg.penumbra ?? 0.1, v => editor.updateLight(id, { penumbra: v }));
            row("Penumbra:", pSl); appendLast(pVl);
        }

        // Rect Area size
        if (cfg.type === "rect") {
            sec("Area Size");
            const [wSl, wVl] = mkSl(0.1, 20, 0.1, cfg.width ?? 2, v => editor.updateLight(id, { width: v }));
            row("Width:", wSl); appendLast(wVl);
            const [hSl, hVl] = mkSl(0.1, 20, 0.1, cfg.height ?? 2, v => editor.updateLight(id, { height: v }));
            row("Height:", hSl); appendLast(hVl);
        }

        // Attenuation
        if (cfg.type === "point" || cfg.type === "spot") {
            sec("Attenuation");
            const [decSl, decVl] = mkSl(0, 4, 0.1, cfg.decay ?? 1, v => editor.updateLight(id, { decay: v }));
            row("Decay:", decSl); appendLast(decVl);
            const [dSl, dVl] = mkSl(0, 50, 0.5, cfg.distance ?? 0, v => editor.updateLight(id, { distance: v }),
                v => v === 0 ? "∞" : v.toFixed(1));
            row("Distance:", dSl); appendLast(dVl);
        }

        // Shadows
        sec("Shadow");
        if (cfg.type === "directional") {
            const chk = document.createElement("input");
            chk.type = "checkbox"; chk.checked = cfg.castShadow ?? false;
            chk.addEventListener("change", () => editor.updateLight(id, { castShadow: chk.checked }));
            const lbl = el("label", { style: "font-size:12px;color:#ccc;cursor:pointer;display:flex;align-items:center;gap:6px;" });
            lbl.append(chk, el("span", {}, "Cast Shadows"));
            propBody.appendChild(lbl);
        } else {
            propBody.appendChild(el("div", { style: "font-size:11px;color:#556;padding:2px 0;" },
                cfg.type === "ambient" || cfg.type === "rect"
                    ? "このライトタイプはシャドウ非対応"
                    : "VRM MToon制限: Point/Spotのシャドウは使用不可"));
        }
    }

    // ---- Add button ----
    addBtn.addEventListener("click", () => {
        lightCounter++;
        const cfg = editor.addLight({
            name: "Light " + lightCounter,
            type: "directional", color: "#ffffff", intensity: 2.0,
            position: { x: 2, y: 4, z: 3 }, target: { x: 0, y: 1, z: 0 },
            castShadow: true, enabled: true,
        });
        selectedId = cfg.id; refreshList(); showProps(cfg.id); editor.selectLightHelper(cfg.id);
    });

    // ---- React to 3D drag position updates ----
    function onHelperMoved(e) {
        if (e.detail.id === selectedId) showProps(selectedId);
    }
    window.addEventListener("lightHelperMoved", onHelperMoved);

    // ---- Initial render ----
    refreshList();
    const lights = editor.getLights();
    if (lights.length > 0) {
        lightCounter = lights.length;
        // Select first non-ambient light for meaningful helpers
        const nonAmbient = lights.find(l => l.type !== "ambient") ?? lights[0];
        selectedId = nonAmbient.id;
        refreshList(); showProps(selectedId); editor.selectLightHelper(selectedId);
    }

    return overlay;
}

// ----------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------
function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") e.style.cssText = v;
        else e.setAttribute(k, v);
    }
    if (text !== undefined) e.textContent = text;
    return e;
}

function mkBtn(label, bg) {
    const b = el("button", {
        style: "padding:4px 10px;background:" + bg + ";color:#fff;border:none;" +
               "border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;",
    }, label);
    b.addEventListener("mouseover", () => { b.style.opacity = "0.8"; });
    b.addEventListener("mouseout",  () => { b.style.opacity = "1"; });
    return b;
}

function mkCloseBtn(fn) {
    const b = el("button", { style: "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;padding:4px 8px;" }, "✕");
    b.onclick = fn;
    return b;
}

function mkToggleBtn(label, isOn) {
    return el("button", {
        style: "padding:4px 11px;background:" + (isOn ? "#3a6a1a" : "#333344") + ";color:#fff;border:none;" +
               "border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;",
    }, label + ": " + (isOn ? "ON" : "OFF"));
}

function applyToggle(btn, label, v) {
    btn.style.background = v ? "#3a6a1a" : "#333344";
    btn.textContent = label + ": " + (v ? "ON" : "OFF");
}

function mkText(val, width) {
    const widthCss = width ? "width:" + width + ";" : "";
    return el("input", {
        type: "text", value: val,
        style: "flex:1;" + widthCss + "background:#111;border:1px solid #444;" +
               "color:#ddd;padding:3px 7px;border-radius:4px;font-size:12px;",
    });
}

function mkSl(min, max, step, value, onChange, fmtFn) {
    const dec = step < 0.1 ? 2 : 1;
    const sl  = document.createElement("input");
    sl.type = "range"; sl.min = min; sl.max = max; sl.step = step; sl.value = value;
    sl.style.cssText = "flex:1;height:14px;accent-color:#4a90d9;cursor:pointer;min-width:60px;";
    sl.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

    let vl;
    if (fmtFn) {
        // カスタム表示（度数など）→ 読み取り専用スパン
        vl = el("span", {
            style: "font-size:11px;color:#aaa;width:40px;text-align:right;flex-shrink:0;",
        }, fmtFn(value));
        sl.addEventListener("input", () => { const v = parseFloat(sl.value); vl.textContent = fmtFn(v); onChange(v); });
    } else {
        // 数値 → 直接入力可能な number input
        vl = document.createElement("input");
        vl.type = "number"; vl.step = step;
        vl.value = parseFloat(value).toFixed(dec);
        vl.style.cssText =
            "width:56px;background:#111;border:1px solid #444;color:#ddd;" +
            "padding:2px 5px;border-radius:4px;font-size:11px;text-align:right;flex-shrink:0;" +
            "appearance:textfield;-moz-appearance:textfield;";
        // スライダー → 数値入力 同期
        sl.addEventListener("input", () => {
            const v = parseFloat(sl.value);
            vl.value = v.toFixed(dec);
            onChange(v);
        });
        // 数値入力 → スライダー 同期
        vl.addEventListener("change", () => {
            let v = parseFloat(vl.value);
            if (isNaN(v)) { vl.value = parseFloat(sl.value).toFixed(dec); return; }
            v = Math.max(min, Math.min(max, v));
            vl.value = v.toFixed(dec);
            sl.value  = v;
            onChange(v);
        });
        vl.addEventListener("wheel",   e => e.stopPropagation(), { passive: true });
        vl.addEventListener("keydown", e => e.stopPropagation()); // ComfyUIのキーショートカット干渉防止
    }
    return [sl, vl];
}

function mkDot(cfg, onClick) {
    const d = el("span", {
        style: "font-size:13px;cursor:pointer;opacity:" + (cfg.enabled ? "1" : "0.3") + ";" +
               "user-select:none;flex-shrink:0;color:" + cfg.color + ";",
        title: cfg.enabled ? "Disable" : "Enable",
    }, "●");
    d.addEventListener("click", e => { e.stopPropagation(); onClick(); });
    return d;
}

function mkDel(onClick) {
    const d = el("span", { style: "font-size:11px;cursor:pointer;color:#774;user-select:none;flex-shrink:0;", title: "Delete" }, "✕");
    d.addEventListener("click", e => { e.stopPropagation(); onClick(); });
    return d;
}

function sep() {
    return el("span", { style: "color:#333;margin:0 2px;" }, "|");
}

function mkFileInput(accept) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept;
    inp.style.cssText = "display:none;";
    document.body.appendChild(inp);
    return inp;
}

function mkNumInput(min, max, step, value, onChange) {
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = min; inp.max = max; inp.step = step;
    inp.value = value;
    inp.style.cssText =
        "width:52px;background:#111;border:1px solid #444;color:#ddd;" +
        "padding:2px 5px;border-radius:4px;font-size:11px;text-align:right;" +
        "appearance:textfield;-moz-appearance:textfield;";
    inp.addEventListener("change", () => {
        let v = parseFloat(inp.value);
        if (isNaN(v)) { inp.value = value; return; }
        v = Math.max(min, Math.min(max, v));
        inp.value = v;
        onChange(v);
    });
    inp.addEventListener("wheel",   e => e.stopPropagation(), { passive: true });
    inp.addEventListener("keydown", e => e.stopPropagation());
    return inp;
}
