Rail Memory v2 — 脚本用背景素材

blue.png：1070 × 730，蓝色票底。
pink.png：1070 × 705，粉红票底。
blank-sheet.png：1070 × 1470，去除文字后的完整参考底图。

来源为用户确认的 output/souvenir-ticket-template/ticket-template-v2.png。
使用内置 ImageGen 去除可变文字，保留底纹、列车图案和空白虚线框；提示词见 background-prompt.txt。
blue.png 是完整底图的 (0,20,1070,750) 裁切，pink.png 是 (0,750,1070,1455) 裁切。
脚本只加载 blue.png / pink.png，无须访问网络、调用 AI 或读取临时目录。
所有文字（包括固定祝福、箭头和底部纪念说明）由 src/ticket_image.py 逐次绘制。
原设计背景为栅格图片，放大不会增加底纹的原生细节；文字按输出尺寸独立绘制。

字体由用户电脑读取，不随项目分发系统字体文件。macOS 默认华文黑体、宋体、Times New Roman、Arial Narrow；其他系统可按说明指定替代字体。字形为按原票视觉特征选用的近似字体，不声称是铁路系统的官方字体文件。
