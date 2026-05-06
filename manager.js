let currentFolderId = null;
let unsavedChanges = false;
let expandedFolders = new Set(["0", "1"]);
let selectedIds = new Set();
let undoStack = [];
let allNodesCache = [];
let searchTimer = null;

const ICON_FOLDER = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZjZDExNiIgZD0iTTEwIDRINHMyIDIgMiAySDJ2MTJoMjB2LTZoLTJ2NmgyVjhoLTJjMC0yLTItMi0yLTJoLTh6Ii8+PC9zdmc+";
const ICON_DEFAULT = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vZyIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0iI2NjYyIvPjwvc3ZnPg==";

document.addEventListener("DOMContentLoaded", async () => {
    byId("btn-save").addEventListener("click", commitChanges);
    byId("btn-undo").addEventListener("click", undoLastAction);
    byId("btn-refresh").addEventListener("click", () => location.reload());
    byId("btn-new-folder").addEventListener("click", createNewFolder);
    byId("btn-expand-all").addEventListener("click", expandAll);
    byId("btn-duplicates").addEventListener("click", showDuplicates);
    byId("btn-empty-folders").addEventListener("click", showEmptyFolders);
    byId("cb-select-all").addEventListener("change", toggleSelectAll);
    byId("btn-delete-selected").addEventListener("click", deleteSelectedNodes);
    byId("search").addEventListener("input", handleSearchInput);

    await loadTree();
});

function byId(id) {
    return document.getElementById(id);
}

function setStatus(message) {
    byId("status").textContent = message || "";
}

async function getAllNodes() {
    const tree = await chrome.bookmarks.getTree();
    const nodes = [];
    function walk(node, path = []) {
        const nextPath = node.id === "0" ? [] : [...path, node.title || "根目录"];
        nodes.push({ ...node, path: nextPath });
        if (node.children) node.children.forEach(child => walk(child, nextPath));
    }
    tree.forEach(root => walk(root));
    allNodesCache = nodes;
    return nodes;
}

async function loadTree() {
    const tree = await chrome.bookmarks.getTree();
    const sidebar = byId("sidebar");
    sidebar.textContent = "";

    const rootNode = tree[0];
    if (!currentFolderId && rootNode.children?.length) {
        currentFolderId = rootNode.children[0].id;
    }

    rootNode.children?.forEach(child => {
        const el = createTreeElement(child);
        if (el) sidebar.appendChild(el);
    });

    if (currentFolderId) await loadMainView(currentFolderId);
    resetSaveState();
    await getAllNodes();
}

function createTreeElement(node) {
    if (node.url) return null;

    const container = document.createElement("div");
    container.className = "tree-item";

    const header = document.createElement("div");
    header.className = `tree-header ${node.id === currentFolderId ? "active" : ""}`;
    header.dataset.id = node.id;

    const isRoot = ["0", "1", "2"].includes(node.id);
    if (!isRoot) header.draggable = true;

    const childFolders = (node.children || []).filter(child => !child.url);
    const childCount = node.children?.length || 0;
    const hasSubFolders = childFolders.length > 0;

    const toggle = document.createElement("span");
    toggle.className = `tree-toggle ${hasSubFolders ? "" : "invisible"}`;
    toggle.textContent = expandedFolders.has(node.id) ? "▼" : "▶";

    const title = document.createElement("span");
    title.className = "tree-name";
    title.textContent = `📁 ${node.title || "未命名文件夹"}`;

    const count = document.createElement("span");
    count.className = "tree-count";
    count.textContent = childCount ? String(childCount) : "";

    header.append(toggle, title, count);

    if (!isRoot) {
        const actions = document.createElement("div");
        actions.className = "tree-actions";
        actions.append(
            makeIconButton("重命名", "✎", async event => {
                event.stopPropagation();
                await renameNode(node.id, node.title, title, "📁 ");
            }),
            makeIconButton("删除", "🗑", async event => {
                event.stopPropagation();
                await deleteNode(node.id, container);
            })
        );
        header.appendChild(actions);
    }

    container.appendChild(header);

    let childrenContainer = null;
    if (hasSubFolders) {
        childrenContainer = document.createElement("div");
        childrenContainer.className = `tree-children ${expandedFolders.has(node.id) ? "open" : ""}`;
        childFolders.forEach(child => childrenContainer.appendChild(createTreeElement(child)));
        container.appendChild(childrenContainer);
    }

    if (hasSubFolders) {
        toggle.addEventListener("click", event => {
            event.stopPropagation();
            const isOpen = childrenContainer.classList.toggle("open");
            toggle.textContent = isOpen ? "▼" : "▶";
            if (isOpen) expandedFolders.add(node.id);
            else expandedFolders.delete(node.id);
        });
    }

    header.addEventListener("click", async () => {
        if (unsavedChanges && !confirm("当前排序还没有同步，切换文件夹会放弃这些排序改动。是否继续？")) return;
        currentFolderId = node.id;
        clearSearch();
        await loadMainView(node.id);
        await markActiveFolder(node.id);
        resetSaveState();
    });

    if (!isRoot) {
        header.addEventListener("dragstart", event => {
            event.dataTransfer.setData("application/json", JSON.stringify({ ids: [node.id], type: "folder" }));
            event.dataTransfer.effectAllowed = "move";
            header.classList.add("dragging");
        });
        header.addEventListener("dragend", () => header.classList.remove("dragging"));
    }

    header.addEventListener("dragover", event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        header.classList.add("drag-over");
    });
    header.addEventListener("dragleave", () => header.classList.remove("drag-over"));
    header.addEventListener("drop", async event => {
        event.preventDefault();
        header.classList.remove("drag-over");
        await handleDropOnFolder(event, node.id);
    });

    return container;
}

function makeIconButton(title, text, handler) {
    const button = document.createElement("button");
    button.className = "icon-btn";
    button.title = title;
    button.textContent = text;
    button.addEventListener("click", handler);
    return button;
}

async function loadMainView(folderId) {
    const container = byId("main-view");
    container.textContent = "";
    selectedIds.clear();
    updateSelectUI();

    const nodes = await chrome.bookmarks.getChildren(folderId);
    if (!nodes.length) {
        renderEmpty(`这个文件夹是空的`);
        return;
    }

    nodes.forEach(node => container.appendChild(createListItem(node)));
}

function createListItem(node, options = {}) {
    const item = document.createElement("div");
    item.className = "list-item";
    if (options.showLocation) item.classList.add("result-item");
    item.draggable = !options.noDrag;
    item.dataset.id = node.id;

    const isFolder = !node.url;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "list-checkbox";

    const icon = document.createElement("img");
    icon.className = "item-icon";
    icon.src = isFolder ? ICON_FOLDER : `_favicon/?pageUrl=${encodeURIComponent(node.url)}&size=32`;
    icon.onerror = () => {
        icon.src = ICON_DEFAULT;
        icon.onerror = null;
    };

    const content = document.createElement("div");
    content.className = "item-content";
    content.title = node.url || node.path?.join(" / ") || "";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = `${isFolder ? "📁 " : ""}${node.title || "(无标题)"}`;

    const url = document.createElement("div");
    url.className = "item-url";
    url.textContent = node.url || node.path?.join(" / ") || "";
    content.append(title, url);

    const actions = document.createElement("div");
    actions.className = "list-actions";
    if (!options.noEdit) {
        actions.append(
            makeIconButton("重命名", "✎", async event => {
                event.stopPropagation();
                await renameNode(node.id, node.title, title, isFolder ? "📁 " : "");
            }),
            makeIconButton("删除", "🗑", async event => {
                event.stopPropagation();
                await deleteNode(node.id, item);
            })
        );
    }
    if (node.parentId && options.showLocation) {
        actions.append(makeIconButton("打开所在文件夹", "↗", async event => {
            event.stopPropagation();
            currentFolderId = node.parentId;
            clearSearch();
            await revealInSidebar(node.parentId);
            await loadMainView(node.parentId);
            resetSaveState();
        }));
    }

    item.append(checkbox, icon, content, actions);

    checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
            selectedIds.add(node.id);
            item.classList.add("selected");
        } else {
            selectedIds.delete(node.id);
            item.classList.remove("selected");
        }
        updateSelectUI();
    });

    item.addEventListener("click", event => {
        if (event.target.closest(".icon-btn") || event.target.closest(".item-content") || event.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
    });

    content.addEventListener("click", async () => {
        if (node.url) {
            window.open(node.url, "_blank");
            return;
        }
        if (unsavedChanges && !confirm("当前排序还没有同步，进入文件夹会放弃这些排序改动。是否继续？")) return;
        currentFolderId = node.id;
        clearSearch();
        await revealInSidebar(node.id);
        await loadMainView(node.id);
        resetSaveState();
    });

    if (!options.noDrag) addDragHandlers(item, node, isFolder);
    return item;
}

function addDragHandlers(item, node, isFolder) {
    item.addEventListener("dragstart", event => {
        if (!selectedIds.has(node.id)) {
            clearSelection();
            selectedIds.add(node.id);
            item.classList.add("selected");
            item.querySelector(".list-checkbox").checked = true;
            updateSelectUI();
        }

        event.dataTransfer.setData("application/json", JSON.stringify({
            ids: Array.from(selectedIds),
            type: "list-items"
        }));
        document.querySelectorAll(".list-item.selected").forEach(el => el.classList.add("dragging"));
    });

    item.addEventListener("dragend", () => {
        document.querySelectorAll(".list-item.dragging").forEach(el => el.classList.remove("dragging"));
        document.querySelectorAll(".drop-into").forEach(el => el.classList.remove("drop-into"));
    });

    item.addEventListener("dragover", event => {
        event.preventDefault();
        if (item.classList.contains("selected")) return;

        const box = item.getBoundingClientRect();
        const isMiddleOfFolder = isFolder
            && event.clientY >= box.top + box.height * 0.25
            && event.clientY <= box.bottom - box.height * 0.25;
        item.classList.toggle("drop-into", isMiddleOfFolder);
    });

    item.addEventListener("dragleave", () => item.classList.remove("drop-into"));

    item.addEventListener("drop", async event => {
        event.preventDefault();
        item.classList.remove("drop-into");
        const data = parseDropData(event);
        if (!data?.ids?.length) return;

        const box = item.getBoundingClientRect();
        const isTop = event.clientY < box.top + box.height * 0.25;
        const isBottom = event.clientY > box.bottom - box.height * 0.25;

        if (isFolder && !isTop && !isBottom) {
            if (data.ids.includes(node.id)) return;
            await moveNodesToFolder(data.ids, node.id);
            document.querySelectorAll(".list-item.selected").forEach(el => el.remove());
            selectedIds.clear();
            updateSelectUI();
            return;
        }

        const draggedElements = data.ids
            .map(id => document.querySelector(`.list-item[data-id="${CSS.escape(id)}"]`))
            .filter(Boolean);
        if (event.clientY > box.top + box.height / 2) item.after(...draggedElements);
        else item.before(...draggedElements);
        markUnsaved();
    });
}

async function handleDropOnFolder(event, folderId) {
    const data = parseDropData(event);
    if (!data?.ids?.length || folderId === currentFolderId) return;

    if (data.type === "folder") {
        const sourceId = data.ids[0];
        if (sourceId === folderId) return;
        if (await checkIsDescendant(sourceId, folderId)) {
            alert("不能把文件夹移动到它自己的子文件夹里。");
            return;
        }
        await moveNodesToFolder([sourceId], folderId);
        expandedFolders.add(folderId);
        await loadTree();
        return;
    }

    await moveNodesToFolder(data.ids, folderId);
    await loadMainView(currentFolderId);
}

function parseDropData(event) {
    try {
        return JSON.parse(event.dataTransfer.getData("application/json"));
    } catch {
        return null;
    }
}

async function captureLocations(ids) {
    const entries = [];
    for (const id of ids) {
        const node = (await chrome.bookmarks.get(id))[0];
        entries.push({ id, parentId: node.parentId, index: node.index });
    }
    return entries;
}

async function moveNodesToFolder(ids, parentId) {
    const before = await captureLocations(ids);
    for (const id of ids) {
        await chrome.bookmarks.move(id, { parentId });
    }
    pushUndo({
        label: `移动 ${ids.length} 项`,
        run: async () => {
            for (const item of before) {
                await chrome.bookmarks.move(item.id, { parentId: item.parentId, index: item.index });
            }
        }
    });
    setStatus(`已移动 ${ids.length} 项`);
}

async function renameNode(id, oldName, titleElement, prefix = "") {
    const newName = prompt("请输入新名称：", oldName || "");
    if (!newName || newName === oldName) return;
    await chrome.bookmarks.update(id, { title: newName });
    titleElement.textContent = `${prefix}${newName}`;
    pushUndo({
        label: "重命名",
        run: async () => chrome.bookmarks.update(id, { title: oldName })
    });
    setStatus("已重命名，可撤销");
}

async function deleteNode(id, element) {
    const [node] = await chrome.bookmarks.getSubTree(id);
    const isFolder = !node.url;
    const count = countDescendants(node);
    const message = isFolder
        ? `确定删除文件夹“${node.title}”及其中 ${count} 个项目吗？`
        : `确定删除书签“${node.title || node.url}”吗？`;
    if (!confirm(message)) return;

    const parentId = node.parentId;
    const index = node.index;
    if (isFolder) await chrome.bookmarks.removeTree(id);
    else await chrome.bookmarks.remove(id);

    element.remove();
    selectedIds.delete(id);
    updateSelectUI();
    pushUndo({
        label: "删除",
        run: async () => restoreNode(node, parentId, index)
    });
    setStatus("已删除，可撤销");
}

async function deleteSelectedNodes() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;

    const nodes = [];
    for (const id of ids) {
        try {
            const [node] = await chrome.bookmarks.getSubTree(id);
            nodes.push(node);
        } catch {
            // The item may already have been removed by another browser sync event.
        }
    }
    if (!nodes.length) return;

    const folderCount = nodes.filter(node => !node.url).length;
    const bookmarkCount = nodes.length - folderCount;
    const message = folderCount
        ? `确定删除 ${bookmarkCount} 个书签和 ${folderCount} 个文件夹吗？文件夹里的内容也会被删除。`
        : `确定删除 ${bookmarkCount} 个所选书签吗？`;
    if (!confirm(message)) return;

    const restoreItems = nodes.map(node => ({
        node,
        parentId: node.parentId,
        index: node.index
    }));

    for (const node of nodes) {
        if (node.url) await chrome.bookmarks.remove(node.id);
        else await chrome.bookmarks.removeTree(node.id);
        document.querySelectorAll(`.list-item[data-id="${CSS.escape(node.id)}"]`).forEach(el => el.remove());
        selectedIds.delete(node.id);
    }

    pushUndo({
        label: `删除 ${nodes.length} 项`,
        run: async () => {
            for (const item of restoreItems) {
                await restoreNode(item.node, item.parentId, item.index);
            }
        }
    });
    updateSelectUI();
    setStatus(`已删除 ${nodes.length} 项，可撤销`);
}

function countDescendants(node) {
    if (!node.children) return 0;
    return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

async function restoreNode(node, parentId, index) {
    const details = { parentId, title: node.title };
    if (typeof index === "number") details.index = index;
    if (node.url) details.url = node.url;
    const created = await chrome.bookmarks.create(details);
    if (node.children?.length) {
        for (const child of node.children) {
            await restoreNode(child, created.id);
        }
    }
}

function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > 20) undoStack.shift();
    byId("btn-undo").disabled = false;
}

async function undoLastAction() {
    const action = undoStack.pop();
    if (!action) return;
    await action.run();
    byId("btn-undo").disabled = undoStack.length === 0;
    await loadTree();
    setStatus(`已撤销：${action.label}`);
}

function toggleSelectAll() {
    const checked = byId("cb-select-all").checked;
    document.querySelectorAll("#main-view .list-item").forEach(item => {
        const checkbox = item.querySelector(".list-checkbox");
        if (!checkbox || checkbox.disabled) return;
        checkbox.checked = checked;
        item.classList.toggle("selected", checked);
        if (checked) selectedIds.add(item.dataset.id);
        else selectedIds.delete(item.dataset.id);
    });
    updateSelectUI();
}

function updateSelectUI() {
    const count = selectedIds.size;
    const items = [...document.querySelectorAll("#main-view .list-item")].filter(item => !item.querySelector(".list-checkbox")?.disabled);
    byId("select-count").textContent = `${count} 已选`;
    byId("cb-select-all").checked = items.length > 0 && count === items.length;
    byId("cb-select-all").indeterminate = count > 0 && count < items.length;
    byId("btn-delete-selected").disabled = count === 0;
}

function clearSelection() {
    selectedIds.clear();
    document.querySelectorAll(".list-item.selected").forEach(item => {
        item.classList.remove("selected");
        const checkbox = item.querySelector(".list-checkbox");
        if (checkbox) checkbox.checked = false;
    });
    updateSelectUI();
}

async function checkIsDescendant(sourceId, targetId) {
    const subtree = await chrome.bookmarks.getSubTree(sourceId);
    let found = false;
    function walk(node) {
        if (node.id === targetId) found = true;
        node.children?.forEach(walk);
    }
    walk(subtree[0]);
    return found;
}

async function revealInSidebar(targetId) {
    let current = (await chrome.bookmarks.get(targetId))[0];
    while (current?.parentId && current.parentId !== "0") {
        expandedFolders.add(current.parentId);
        current = (await chrome.bookmarks.get(current.parentId))[0];
    }
    expandedFolders.add(targetId);
    await loadTree();
    await markActiveFolder(targetId);
}

async function markActiveFolder(folderId) {
    document.querySelectorAll(".tree-header").forEach(el => el.classList.remove("active"));
    const active = document.querySelector(`.tree-header[data-id="${CSS.escape(folderId)}"]`);
    if (active) {
        active.classList.add("active");
        active.scrollIntoView({ block: "center", behavior: "smooth" });
    }
}

function expandAll() {
    document.querySelectorAll(".tree-children").forEach(el => el.classList.add("open"));
    document.querySelectorAll(".tree-toggle:not(.invisible)").forEach(el => {
        el.textContent = "▼";
        const header = el.closest(".tree-header");
        if (header?.dataset.id) expandedFolders.add(header.dataset.id);
    });
}

function markUnsaved() {
    unsavedChanges = true;
    const button = byId("btn-save");
    button.disabled = false;
    button.textContent = "保存排序";
    button.classList.add("btn-danger");
    setStatus("排序待同步");
}

function resetSaveState() {
    unsavedChanges = false;
    const button = byId("btn-save");
    button.disabled = true;
    button.textContent = "同步排序";
    button.classList.remove("btn-danger");
}

async function commitChanges() {
    const button = byId("btn-save");
    button.disabled = true;
    button.textContent = "写入中...";
    const items = [...document.querySelectorAll("#main-view .list-item")];
    const before = await captureLocations(items.map(item => item.dataset.id));
    for (let i = 0; i < items.length; i++) {
        await chrome.bookmarks.move(items[i].dataset.id, { parentId: currentFolderId, index: i });
    }
    pushUndo({
        label: "排序",
        run: async () => {
            for (const item of before) {
                await chrome.bookmarks.move(item.id, { parentId: item.parentId, index: item.index });
            }
        }
    });
    resetSaveState();
    setStatus("排序已同步，可撤销");
}

async function createNewFolder() {
    const name = prompt("文件夹名称：");
    if (!name) return;
    const node = await chrome.bookmarks.create({ parentId: currentFolderId, title: name });
    pushUndo({
        label: "新建文件夹",
        run: async () => chrome.bookmarks.removeTree(node.id)
    });
    expandedFolders.add(currentFolderId);
    await loadTree();
    setStatus("已新建文件夹，可撤销");
}

function handleSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchBookmarks, 180);
}

function clearSearch() {
    byId("search").value = "";
}

async function searchBookmarks() {
    const query = byId("search").value.trim().toLowerCase();
    if (!query) {
        await loadMainView(currentFolderId);
        setStatus("");
        return;
    }

    const nodes = await getAllNodes();
    const results = nodes.filter(node => {
        if (node.id === "0") return false;
        const haystack = `${node.title || ""} ${node.url || ""} ${domainOf(node.url)} ${node.path?.join(" ") || ""}`.toLowerCase();
        return haystack.includes(query);
    }).slice(0, 300);

    renderResultList(`搜索结果：${results.length} 项`, results, { noDrag: true, showLocation: true });
}

async function showDuplicates() {
    const nodes = await getAllNodes();
    const groups = new Map();
    nodes.filter(node => node.url).forEach(node => {
        const key = normalizeUrl(node.url);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
    });

    const duplicates = [...groups.values()]
        .filter(group => group.length > 1)
        .flat();
    renderResultList(`重复书签：${duplicates.length} 项`, duplicates, { noDrag: true, showLocation: true });
}

async function showEmptyFolders() {
    const nodes = await getAllNodes();
    const folders = nodes.filter(node => !node.url && node.id !== "0" && (!node.children || node.children.length === 0));
    renderResultList(`空文件夹：${folders.length} 个`, folders, { noDrag: true, showLocation: true });
}

function renderResultList(title, nodes, options = {}) {
    const container = byId("main-view");
    container.textContent = "";
    selectedIds.clear();
    updateSelectUI();

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = title;
    container.appendChild(hint);

    if (!nodes.length) {
        renderEmpty("没有找到结果");
        return;
    }

    nodes.forEach(node => container.appendChild(createListItem(node, options)));
    setStatus(title);
}

function renderEmpty(text) {
    const container = byId("main-view");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = text;
    container.appendChild(empty);
}

function normalizeUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        parsed.searchParams.sort();
        return parsed.toString().replace(/\/$/, "");
    } catch {
        return url;
    }
}

function domainOf(url) {
    if (!url) return "";
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}
