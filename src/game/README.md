# 登月舱起飞

地址后加 `/#debug`，勾选“登月舱快速测试”可把登月舱移到人物附近，跳过碎片门槛，步行时直接按 E 测试起飞。取消勾选或关闭调试面板会恢复原位置与探索规则，已经收集的碎片保持不变；开始起飞后需在结局选择“重新开始”再测。

按阿波罗登月舱的工作方式设计：下降级、支腿、四角 RCS 喷流挡板及支架留在月面，上升级分离后垂直加速。现有 GLB 按焊接后的连通零件重组，过滤原资源中远离主体的两枚孤立圆球，保留有效零件的三角形与材质，不直接横切舱体；另补充简化的中央上升喷管与下降级喷流通道，喷管轮廓不作为工程尺寸模型。导航记录靠射频强度/方位仪表与小地图标记寻找；步行靠近后按 F 黑场采样，变亮后在脚印高度图写入 scoop trench 形变（与脚印同一月表通道），车上需先下车。

起飞瞬间有短促闪光、低角度抛出的月尘和翻滚的隔热碎片。主喷流从 [aeronautic 的 Rocket Mixture 示例](https://github.com/Romainlg29/aeronautic/blob/main/apps/docs/examples/rocket-mix.tsx)移植，采用体积光线步进、黑体光谱和湍流混合层，颜色与强度沿用示例的视觉风格。原项目的 WebGPU / TSL 实现改写为当前 WebGL 流程可用的 GLSL，在半分辨率缓冲绘制，并使用主场景深度遮挡下降级和地面；探索期间不增加体积绘制，不新增动态灯或阴影通道。许可与具体来源见 [许可与来源](../../public/licenses/aeronautic.txt)。

过场约 1 秒准备、至 3.7 秒级间分离字幕、再垂直上升到约 7 秒后黑场淡出，不播放转向入轨。初段升高仍按约 1:1 简化，并非工程级轨道解算；登月舱上升级不能直接返回地球。

## 资料

- [NASA《Apollo Expeditions to the Moon》，第 4.3 节](https://www.nasa.gov/wp-content/uploads/static/history/SP-350/ch-4-3.html)：上下级分工、下降级充当发射台、上升发动机约 3500 磅推力、自燃推进剂及月球轨道交会。
- [NASA《Apollo 11》新闻资料](https://www.nasa.gov/wp-content/uploads/static/apollo50th/pdf/A11_PressKit.pdf)：约起飞十秒、250 英尺高度开始俯仰。场景中对应约 75 米升高。
- [NASA 月面日志：阿波罗 15 隔热毯飞行分析](https://www.nasa.gov/wp-content/uploads/static/history/alsj/WOTM/WOTM-A15BlanketFlight.html)：分离附近的短促光亮、喷流抛出的隔热材料及无大气环境下的翻滚和弹道。
- [阿波罗月面日志：阿波罗 17 月面起飞影像](https://apollojournals.org/alsj/a17/video17.html#launch)：从月球车拍摄的起飞、尘土与隔热材料抛散，以及外部跟拍构图。
- [Grumman/NASA《LM-10 操作手册》（月面日志存档）](https://apollojournals.org/alsj/LM10HandbookVol1.pdf)：喷流挡板及支架固定在下降级。
- [史密森尼上升发动机藏品](https://airandspace.si.edu/collection-objects/rocket-engine-liquid-fuel-apollo-lunar-module-ascent-engine/nasm_A19721346000)：喷管照片及最大直径约 82.55 厘米，供补充喷管比例参考。
