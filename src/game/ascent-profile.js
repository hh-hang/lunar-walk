// 只展示起飞初段垂直爬升；入轨与交会不在场景中展开。
/** 登舱亮起后倒计时再脱离；与 HUD 左下角数字一致。 */
export const IGNITION_TIME = 3;
export const SEPARATION_END = IGNITION_TIME + 2.7;
/** 开始黑场淡出的时刻；舱体继续上升直到 ASCENT_MOTION_DURATION。 */
export const ASCENT_DURATION = IGNITION_TIME + 6;
export const ENDING_FADE_DURATION = 1.4;
export const ASCENT_MOTION_DURATION = ASCENT_DURATION + ENDING_FADE_DURATION;
/** 本过场不做俯仰转向；阈值高于运动时长即可。 */
export const PITCH_TIME = ASCENT_MOTION_DURATION;
export const LUNAR_GRAVITY = 1.62;

/** 初段轨迹按约 1:1 升高；黑场淡出期间仍继续上升，完全淡出后才停。 */
export function sampleAscent(elapsed) {
  const flightTime = Math.max(0, Math.min(elapsed, ASCENT_MOTION_DURATION) - IGNITION_TIME);
  const turnTime = Math.max(0, flightTime - PITCH_TIME);
  return {
    flightTime,
    height: 0.75 * flightTime * flightTime,
    distance: 0.24 * turnTime * turnTime * turnTime,
    pitch: Math.min(0.28, turnTime * 0.06),
    powered: elapsed >= IGNITION_TIME,
    flash: elapsed >= IGNITION_TIME ? Math.max(0, 1 - flightTime / 0.22) : 0,
    label: elapsed < IGNITION_TIME ? '上升准备' : elapsed < SEPARATION_END ? '级间分离' : '垂直上升',
  };
}
