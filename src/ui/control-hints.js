/** 创建步行、驾驶与上车提示，学会操作后自动淡出。 */
export function createControlHints(player) {
  const boardHint = document.getElementById('board-hint');
  const controlHint = document.getElementById('control-hint');
  /** 根据静止车辆的上车距离显示提示，并切换步行或驾驶说明。 */
  function updateBoardHint() {
    let visible = false;
    if (player.getControllerMode() === 0 && !player.isFlying) {
      const position = player.playerCapsule.position;
      for (const vehicle of player.getAllVehicles()) {
        if (!player.vehicle.isInBoardingRange(vehicle, position)) continue;
        const velocity = vehicle.chassisBody.linvel();
        if (Math.hypot(velocity.x, velocity.z) > 0.1) continue;
        visible = true;
        break;
      }
    }
    boardHint.classList.toggle('show', visible);
    controlHint.classList.toggle('driving', player.getControllerMode() === 1);
  }
  const learnedHints = new Set();
  /** 记录已学习的操作，并淡出对应模式的提示。 */
  function dismissHint(name, shared = false) {
    const mode = player.getControllerMode() === 1 ? 'driving' : 'on-foot';
    const key = shared ? name : `${mode}:${name}`;
    if (learnedHints.has(key)) return;
    learnedHints.add(key);
    const root = shared ? controlHint : controlHint.querySelector(`.${mode}`);
    root.querySelectorAll(`[data-hint="${name}"]`).forEach((hint) => {
      if (hint.classList.contains('done')) return;
      hint.classList.add('done');
      /** 结束淡出后移除提示占位。 */
      const hide = () => hint.classList.add('gone');
      hint.addEventListener(
        'transitionend',
        (event) => {
          if (event.propertyName === 'opacity') hide();
        },
        { once: true },
      );
      setTimeout(hide, 450);
    });
  }
  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code))
      dismissHint('move');
    else if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') dismissHint('shift');
    else if (event.code === 'Space') dismissHint('space');
    else if (event.code === 'KeyV') dismissHint('view', true);
  });
  document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement && (event.movementX || event.movementY)) dismissHint('look', true);
  });

  return { update: updateBoardHint, dismiss: dismissHint };
}
