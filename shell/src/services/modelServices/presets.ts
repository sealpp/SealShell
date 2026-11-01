import type { ModelProtocol } from './types'

export interface ServicePreset { id: string; name: string; baseUrl: string; protocol: ModelProtocol; website: string; region: 'cn' | 'global' | 'custom' }
const preset = (id: string, name: string, baseUrl: string, website: string, protocol: ModelProtocol = 'openai-chat', region: ServicePreset['region'] = 'cn'): ServicePreset => ({ id, name, baseUrl, website, protocol, region })
export const servicePresets: ServicePreset[] = [
  preset('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'https://platform.deepseek.com/'),
  preset('dashscope', '阿里云百炼', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://bailian.console.aliyun.com/'),
  preset('doubao', '火山方舟 · 豆包', 'https://ark.cn-beijing.volces.com/api/v3', 'https://console.volcengine.com/ark/'),
  preset('siliconflow', '硅基流动', 'https://api.siliconflow.cn/v1', 'https://cloud.siliconflow.cn/'),
  preset('zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/'),
  preset('moonshot', '月之暗面 · Kimi', 'https://api.moonshot.cn/v1', 'https://platform.moonshot.cn/'),
  preset('minimax', 'MiniMax', 'https://api.minimaxi.com/anthropic/v1', 'https://platform.minimaxi.com/', 'anthropic'),
  preset('hunyuan', '腾讯混元', 'https://api.hunyuan.cloud.tencent.com/v1', 'https://console.cloud.tencent.com/hunyuan/'),
  preset('qianfan', '百度千帆', 'https://qianfan.baidubce.com/v2', 'https://console.bce.baidu.com/qianfan/'),
  preset('modelscope', '魔搭 ModelScope', 'https://api-inference.modelscope.cn/v1', 'https://modelscope.cn/'),
  preset('ppio', '派欧云 PPIO', 'https://api.ppinfra.com/v3/openai', 'https://ppio.com/'),
  preset('stepfun', '阶跃星辰', 'https://api.stepfun.com/v1', 'https://platform.stepfun.com/'),
  preset('baichuan', '百川智能', 'https://api.baichuan-ai.com/v1', 'https://platform.baichuan-ai.com/'),
  preset('qiniu', '七牛云', 'https://api.qnaigc.com/v1', 'https://ai.qiniu.com/'),
  preset('longcat', '美团 LongCat', 'https://api.longcat.chat/openai/v1', 'https://longcat.chat/'),
  preset('openai', 'OpenAI', 'https://api.openai.com/v1', 'https://platform.openai.com/', 'openai-responses', 'global'),
  preset('anthropic', 'Anthropic · Claude', 'https://api.anthropic.com/v1', 'https://console.anthropic.com/', 'anthropic', 'global'),
  preset('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/', 'openai-chat', 'global'),
  preset('custom', '自定义服务', '', '', 'openai-chat', 'custom'),
]
