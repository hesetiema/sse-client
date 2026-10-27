// 可编辑配置面板：把示例里写死的参数搬到页面上，改完自动重建连接。
//
//   createPanel(root, [
//     { key: "scenario", label: "场景", type: "select", options: [["normal", "normal 正常"]] },
//     { key: "interval", label: "间隔 ms", type: "number", min: 200, max: 5000, step: 100 },
//     { key: "persist", label: "跨刷新记住位点", type: "checkbox" },
//   ], {
//     defaults: { scenario: "normal", interval: 800, persist: true },
//     storageKey: "demo:alarm-center:config",
//     onApply: (config) => connect(config),
//   });
//
// 约定：
// - 改动 300ms 内合并成一次 `onApply`，避免连续输入时反复断开重连；
// - 配置存 sessionStorage，刷新后沿用（和「跨刷新续传」是两个独立概念）；
// - 每个输入都带 data-key，方便自动化脚本定位（demo/consumers-check.mjs 在用）。

const APPLY_DELAY = 300;

/**
 * @param {HTMLElement} root 容器
 * @param {Array<object>} fields 字段描述，见文件头
 * @param {{ defaults?: object, storageKey?: string, onApply?: (config: object) => void }} options
 */
export function createPanel(root, fields, options = {}) {
  const { defaults = {}, storageKey, onApply } = options;
  const state = { ...defaults, ...read(storageKey, fields) };

  let timer = 0;
  const note = document.createElement("span");
  note.className = "note";
  note.textContent = "改动后自动重连";

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      write(storageKey, state);
      note.dataset.state = "applied";
      note.textContent = "已按新配置重连";
      onApply?.({ ...state });
    }, APPLY_DELAY);
  };

  const controls = fields.map((field) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.dataset.key = field.key;

    const caption = document.createElement("span");
    caption.textContent = field.label;
    wrap.append(caption);

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      for (const [value, label] of field.options ?? []) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        input.append(option);
      }
      input.value = String(state[field.key]);
      input.addEventListener("change", () => {
        state[field.key] = input.value;
        schedule();
      });
    } else if (field.type === "checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(state[field.key]);
      input.addEventListener("change", () => {
        state[field.key] = input.checked;
        schedule();
      });
    } else {
      input = document.createElement("input");
      input.type = field.type ?? "text";
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      if (field.placeholder) input.placeholder = field.placeholder;
      input.value = state[field.key] === undefined ? "" : String(state[field.key]);
      input.addEventListener("input", () => {
        state[field.key] = normalize(input, field);
        schedule();
      });
      // 失焦时把夹紧后的值写回输入框，肉眼能看到实际生效的值。
      input.addEventListener("blur", () => {
        input.value = String(state[field.key] ?? "");
      });
    }

    wrap.append(input);
    root.append(wrap);
    return input;
  });

  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "重新连接";
  apply.addEventListener("click", schedule);
  root.append(apply);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "恢复默认";
  reset.addEventListener("click", () => {
    Object.assign(state, defaults);
    for (const [index, field] of fields.entries()) {
      const input = controls[index];
      if (field.type === "checkbox") input.checked = Boolean(state[field.key]);
      else input.value = String(state[field.key] ?? "");
    }
    schedule();
  });
  root.append(reset, note);

  // 页面加载即按当前配置连一次：面板是唯一的入口，不该等到用户动一下才连。
  onApply?.({ ...state });

  return {
    get state() {
      return { ...state };
    },
    apply: schedule,
  };
}

function normalize(input, field) {
  if (field.type === "number") {
    const raw = input.value.trim();
    if (raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) return undefined;
    const min = field.min ?? -Infinity;
    const max = field.max ?? Infinity;
    return Math.min(Math.max(value, min), max);
  }
  return input.value;
}

function read(storageKey, fields) {
  if (!storageKey) return {};
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
    const allowed = new Set(fields.map((field) => field.key));
    // 只认 schema 里还有的键：删掉的字段不能把新默认值顶掉。
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => allowed.has(key)));
  } catch {
    return {};
  }
}

function write(storageKey, state) {
  if (!storageKey) return;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // 存储不可用时只是不记住，不影响重连
  }
}
