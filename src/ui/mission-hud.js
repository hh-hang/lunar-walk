import { ASCENT_DURATION } from '../game/ascent-profile.js';
import { ENDING_FADE_DURATION } from '../game/mission-state.js';
import { t } from './locale.js';

/** 与 three-player-controller 上车键同位同款的圆形触控钮；触控在 touchstart 触发，与 CAR 一致。 */
function createMobileActionButton(onTrigger) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mission-mobile-action';
  btn.hidden = true;
  btn.setAttribute('aria-label', t('任务交互', 'Mission action'));
  const idleShadow =
    '0 6px 12px rgba(0,0,0,0.45), 0 2px 4px rgba(0,0,0,0.35), inset 0 2px 2px rgba(255,255,255,0.24), inset 0 -2px 3px rgba(0,0,0,0.5)';
  const pressedShadow =
    '0 2px 5px rgba(0,0,0,0.35), inset 0 2px 4px rgba(0,0,0,0.65), inset 0 -1px 1px rgba(255,255,255,0.12)';
  const setPressed = (pressed) => {
    btn.classList.toggle('pressed', pressed);
    btn.style.boxShadow = pressed ? pressedShadow : idleShadow;
  };
  let touchArmed = false;
  btn.addEventListener(
    'touchstart',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      touchArmed = true;
      setPressed(true);
      onTrigger?.();
    },
    { passive: false },
  );
  for (const name of ['touchend', 'touchcancel']) {
    btn.addEventListener(
      name,
      (event) => {
        event.preventDefault();
        setPressed(false);
      },
      { passive: false },
    );
  }
  btn.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') return;
    setPressed(true);
  });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
    btn.addEventListener(name, () => setPressed(false));
  }
  // 鼠标 / 桌面模拟器用 click；真机 touchstart 已处理，避免 preventDefault 后 click 丢失。
  btn.addEventListener('click', (event) => {
    if (touchArmed) {
      touchArmed = false;
      event.preventDefault();
      return;
    }
    onTrigger?.();
  });
  document.body.append(btn);
  return btn;
}

/** 创建极简任务进度与返航结局，兼容键盘与触屏。 */
export function createMissionHUD({ onReturn, onSample, onRestart }) {
  const root = document.createElement('section');
  root.className = 'mission';
  root.setAttribute('aria-label', t('采样任务', 'Sample mission'));
  root.innerHTML = `
    <p class="mission-label"><span class="zh">采样</span><span class="en">Samples</span></p>
    <div class="mission-progress"><span class="mission-pips" aria-hidden="true"><i></i><i></i><i></i></span><span class="mission-count" aria-live="polite">0 / 3</span></div>`;
  // 桌面：屏幕中央 F 提示，样式对齐上车提示。
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'mission-action';
  action.hidden = true;
  action.innerHTML = '<span class="board-key">F</span><span class="zh">登舱</span><span class="en">Embark</span>';
  let actionMode = '';
  const triggerAction = () => {
    if (actionMode === 'sample') onSample?.();
    else onReturn?.();
  };
  // 移动：与上车键同位置的圆形按钮（vehicle: right 14 / bottom 158）。
  const mobileAction = createMobileActionButton(triggerAction);
  /** 切换中央提示与触控钮文案：采样或登舱。 */
  function setActionMode(mode) {
    if (actionMode === mode) return;
    actionMode = mode;
    if (mode === 'sample') {
      action.innerHTML = '<span class="board-key">F</span><span class="zh">采样</span><span class="en">Sample</span>';
      mobileAction.textContent = 'DIG';
      mobileAction.setAttribute('aria-label', t('采样', 'Sample'));
    } else {
      action.innerHTML = '<span class="board-key">F</span><span class="zh">登舱</span><span class="en">Embark</span>';
      mobileAction.textContent = 'PAD';
      mobileAction.setAttribute('aria-label', t('登舱', 'Embark'));
    }
  }
  action.addEventListener('click', triggerAction);
  document.querySelector('.hud').append(root);
  // 触屏视角层位于 HUD 上方，独立挂载按钮，保证原生点击和触摸都能命中。
  document.body.append(action);
  // 挂在 body：过场会隐藏 .hud，倒计时仍需留在左下角。
  const countdown = document.createElement('p');
  countdown.className = 'mission-countdown';
  countdown.hidden = true;
  countdown.setAttribute('aria-live', 'assertive');
  countdown.setAttribute('aria-label', t('脱离倒计时', 'Detachment countdown'));
  document.body.append(countdown);
  const veil = document.createElement('div');
  veil.className = 'mission-ending-veil';
  veil.hidden = true;
  veil.setAttribute('aria-hidden', 'true');
  document.body.append(veil);
  const ending = document.createElement('dialog');
  ending.className = 'mission-ending';
  ending.setAttribute('aria-label', t('重新开始', 'Restart'));
  ending.innerHTML = `
    <div class="mission-ending-mark">
      <p class="loading-title">Lunar Walk</p>
      <button type="button" class="mission-ending-restart"><span class="zh">重新开始</span><span class="en">Restart</span></button>
    </div>`;
  ending.addEventListener('cancel', (event) => event.preventDefault());
  ending.querySelector('button').addEventListener('click', () => onRestart?.());
  document.body.append(ending);
  const label = root.querySelector('.mission-label');
  const count = root.querySelector('.mission-count');
  const pips = [...root.querySelectorAll('.mission-pips i')];
  let previousCount = -1, previousPhase = '';
  /** 登舱 / 采样黑场占用 veil 时，结局淡出不得覆盖透明度。 */
  let boardVeilActive = false;

  /** 采齐三处后改「回舱」，否则保持「采样」。 */
  function syncLabel(collectedCount) {
    const done = collectedCount >= 3;
    label.innerHTML = done
      ? '<span class="zh">回舱</span><span class="en">Return</span>'
      : '<span class="zh">采样</span><span class="en">Samples</span>';
    root.setAttribute('aria-label', done ? t('回舱任务', 'Return mission') : t('采样任务', 'Sample mission'));
  }

  /** 统一黑场：opacity≤0 时隐藏，避免 pointer/合成层残留。 */
  function applyVeil(opacity) {
    const visible = opacity > 0.001;
    veil.hidden = !visible;
    veil.style.opacity = String(visible ? Math.min(1, opacity) : 0);
  }

  /** 过渡黑场：先暗后亮；亮起阶段由任务侧切换真实结果。 */
  function setBoardVeil(opacity) {
    boardVeilActive = opacity > 0.001;
    applyVeil(opacity);
  }

  /** 左下角脱离倒计时：整秒显示，到 0 后隐藏。 */
  function setDetachCountdown(seconds) {
    const value = Math.ceil(seconds);
    if (value > 0) {
      countdown.hidden = false;
      countdown.textContent = String(value);
    } else {
      countdown.hidden = true;
      countdown.textContent = '';
    }
  }

  /** 同步桌面中央提示与移动圆形钮；上下车优先时两者皆隐藏。 */
  function syncAction(visible) {
    action.hidden = !visible;
    mobileAction.hidden = !visible;
  }

  /** 起飞无底部字幕；镜头结束后黑场淡出，再展现重新开始。 */
  function update(state, { canReturn, canSample = false, detachCountdown = 0 }, delta) {
    if (previousCount !== state.collectedCount) {
      previousCount = state.collectedCount;
      count.textContent = `${previousCount} / 3`;
      pips.forEach((pip, index) => pip.classList.toggle('collected', index < previousCount));
      syncLabel(previousCount);
    }
    root.classList.toggle('unlocked', Boolean(state.mapTarget));
    // 与按键优先级一致：上下车时不抢提示；其余为采样 > 登舱。
    if (canSample) {
      setActionMode('sample');
      syncAction(true);
    } else if (canReturn) {
      setActionMode('board');
      syncAction(true);
    } else {
      syncAction(false);
    }
    setDetachCountdown(detachCountdown);
    if (!boardVeilActive) {
      const fading = state.phase === 'returning' && state.returnElapsed >= ASCENT_DURATION;
      const fadeProgress = state.phase === 'complete' ? 1
        : fading ? Math.min(1, (state.returnElapsed - ASCENT_DURATION) / ENDING_FADE_DURATION)
          : 0;
      applyVeil(fadeProgress);
    }
    if (previousPhase !== state.phase) {
      previousPhase = state.phase;
      document.body.classList.toggle('mission-cinematic', state.phase !== 'exploring');
      root.classList.toggle('unlocked', Boolean(state.mapTarget));
      if (state.phase === 'complete') {
        ending.classList.remove('ready');
        ending.showModal();
        // showModal 会自动聚焦首个按钮并带出系统/浏览器焦点环，立刻失焦保持默认描边态。
        ending.querySelector('button')?.blur();
        // 双 rAF：等 dialog 完成显示后再触发内容淡入，避免首帧跳变。
        requestAnimationFrame(() => {
          ending.querySelector('button')?.blur();
          requestAnimationFrame(() => ending.classList.add('ready'));
        });
      }
    }
  }

  /** 关闭结局并清掉过场 UI，下一次 update 会按探索状态重新同步。 */
  function reset() {
    if (ending.open) ending.close();
    ending.classList.remove('ready');
    previousCount = -1;
    previousPhase = '';
    boardVeilActive = false;
    actionMode = '';
    syncAction(false);
    setDetachCountdown(0);
    root.classList.remove('unlocked');
    count.textContent = '0 / 3';
    pips.forEach((pip) => pip.classList.remove('collected'));
    syncLabel(0);
    applyVeil(0);
    document.body.classList.remove('mission-cinematic');
  }

  /** 移除任务界面、触屏操作与结局对话框。 */
  function dispose() {
    root.remove();
    action.remove();
    mobileAction.remove();
    countdown.remove();
    veil.remove();
    ending.remove();
    document.body.classList.remove('mission-cinematic');
  }
  return { update, reset, dispose, setBoardVeil };
}
