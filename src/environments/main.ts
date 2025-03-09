// LICENSE GPL3.0 https://github.com/xjh22222228/nav/blob/main/LICENSE
// 未授权擅自使用自有部署软件（当前文件），一旦发现将追究法律责任，https://official.nav3.cn/pricing
// 开源项目，未经作者同意，不得以抄袭/复制代码/修改源代码版权信息。
// Copyright @ 2018-present xiejiahe. All rights reserved.
// See https://github.com/xjh22222228/nav

import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import bodyParser from 'body-parser'
import history from 'connect-history-api-fallback'
import compression from 'compression'
import nodemailer from 'nodemailer'
import dayjs from 'dayjs'
import getWebInfo from 'info-web'
import yaml from 'js-yaml'
import {
  getWebCount,
  setWebs,
  spiderWeb,
  writeSEO,
  writeTemplate,
  PATHS,
} from '../../scripts/utils'
import {
  ISettings,
  INavProps,
  IWebProps,
  ITagPropValues,
  ISearchProps,
  InternalProps,
} from '../types/index'
import { SELF_SYMBOL } from '../constants/symbol'
import axios from 'axios'
import { HTTP_BASE_URL } from '../utils/http'

const joinPath = (p: string): string => path.resolve(p)

const getConfigJson = () =>
  yaml.load(fs.readFileSync(PATHS.config, 'utf8')) as any
const PORT = getConfigJson().port

const getSettings = () =>
  JSON.parse(fs.readFileSync(PATHS.settings, 'utf8')) as ISettings
const getCollects = (): IWebProps[] => {
  try {
    const data = JSON.parse(fs.readFileSync(PATHS.collect, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
const getComponents = (): any[] => {
  try {
    return JSON.parse(fs.readFileSync(PATHS.component, 'utf8')) as any[]
  } catch {
    return []
  }
}

try {
  ;[
    PATHS.db,
    PATHS.settings,
    PATHS.tag,
    PATHS.search,
    PATHS.html.index,
    PATHS.component,
  ].forEach((path) => {
    fs.chmodSync(path, 0o777)
  })
} catch (error) {
  console.log((error as Error).message)
}

// Create user collect
try {
  fs.accessSync(PATHS.collect, fs.constants.F_OK)
} catch (error) {
  fs.writeFileSync(PATHS.collect, '[]')
  console.log((error as Error).message)
}

const app = express()

app.use(compression())
app.use(history())
app.use(bodyParser.json({ limit: '10000mb' }))
app.use(bodyParser.urlencoded({ limit: '10000mb', extended: true }))
app.use(
  cors({
    origin: '*',
    methods: '*',
    allowedHeaders: '*',
  })
)
app.use(express.static('dist/browser'))
app.use(express.static('_upload'))

async function sendMail() {
  const mailConfig = getConfigJson().mailConfig
  const transporter = nodemailer.createTransport({
    ...mailConfig,
    message: undefined,
    title: undefined,
  })
  await transporter.sendMail({
    from: mailConfig.auth.user,
    to: getSettings().email || getConfigJson().email,
    subject: mailConfig.title || '',
    html: mailConfig.message || '',
  })
}

function verifyMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['authorization']
  if (token !== `token ${getConfigJson().password}`) {
    res.status(401).json({
      status: 401,
      message: 'Bad credentials',
    })
    return
  }
  next(false)
}

app.get(
  '/api/users/verify',
  verifyMiddleware,
  (req: Request, res: Response) => {
    res.json({})
  }
)

app.post(
  '/api/contents/update',
  verifyMiddleware,
  (req: Request, res: Response) => {
    const { path, content } = req.body
    try {
      fs.writeFileSync(joinPath(path), content)

      if (path.includes('settings.json')) {
        const isExistsindexHtml = fs.existsSync(PATHS.html.index)
        if (isExistsindexHtml) {
          const indexHtml = fs.readFileSync(PATHS.html.index, 'utf8')
          const webs = JSON.parse(fs.readFileSync(PATHS.db, 'utf8'))
          const settings = getSettings()
          const seoTemplate = writeSEO(webs, { settings })
          const html = writeTemplate({
            html: indexHtml,
            settings,
            seoTemplate,
          })
          fs.writeFileSync(PATHS.html.index, html)
        }
      }

      res.json({})
    } catch (error) {
      res.status(500).json({
        message: (error as Error).message,
      })
    }
  }
)

app.post(
  '/api/contents/create',
  verifyMiddleware,
  (req: Request, res: Response) => {
    const { path: filePath, content } = req.body
    try {
      try {
        fs.statSync(PATHS.upload)
      } catch (error) {
        fs.mkdirSync(PATHS.upload, { recursive: true })
      }

      const dataBuffer = Buffer.from(content, 'base64')
      const uploadPath = path.join(PATHS.upload, filePath)
      fs.writeFileSync(uploadPath, dataBuffer)
      res.json({
        imagePath: path.join('/', 'images', filePath),
      })
    } catch (error) {
      res.status(500).json({
        message: (error as Error).message,
      })
    }
  }
)

interface Contents {
  settings: ISettings
  webs: INavProps[]
  tags: ITagPropValues[]
  search: ISearchProps[]
  internal: InternalProps
  components: any[]
}

app.post('/api/contents/get', (req: Request, res: Response) => {
  const params: Contents = {
    webs: [],
    settings: {} as ISettings,
    tags: [],
    search: [],
    internal: {} as InternalProps,
    components: [],
  }
  try {
    params.webs = JSON.parse(fs.readFileSync(PATHS.db, 'utf8'))
    params.settings = getSettings()
    params.components = getComponents()
    params.tags = JSON.parse(fs.readFileSync(PATHS.tag, 'utf8'))
    params.search = JSON.parse(fs.readFileSync(PATHS.search, 'utf8'))
    const { userViewCount, loginViewCount } = getWebCount(params.webs)
    params.internal.userViewCount = userViewCount
    params.internal.loginViewCount = loginViewCount
    params.webs = setWebs(params.webs, params.settings, params.tags)
    res.json(params)
    return
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
  }
})

app.post('/api/spider', async (req: Request, res: Response) => {
  try {
    const webs = JSON.parse(fs.readFileSync(PATHS.db, 'utf8'))
    const settings = getSettings()
    const { time, webs: w, errorUrlCount } = await spiderWeb(webs, settings)
    settings.errorUrlCount = errorUrlCount
    fs.writeFileSync(PATHS.db, JSON.stringify(w))
    fs.writeFileSync(PATHS.settings, JSON.stringify(settings))
    res.json({
      time,
    })
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
  }
})

app.post('/api/collect/get', async (req: Request, res: Response) => {
  try {
    const collects = getCollects()
    res.json({
      data: collects,
      count: collects.length,
    })
  } catch (error) {
    res.json({
      data: [],
      count: 0,
      message: (error as Error).message,
    })
  }
})

app.post('/api/collect/delete', async (req: Request, res: Response) => {
  try {
    const { data } = req.body
    const collects = getCollects().filter((e) => {
      const has = data.some(
        (item: IWebProps) => item['extra'].uuid === e['extra'].uuid
      )
      return !has
    })
    fs.writeFileSync(PATHS.collect, JSON.stringify(collects))
    res.json({
      data: collects,
    })
  } catch (error) {
    res.json({
      data: [],
      message: (error as Error).message,
    })
  }
})

app.post('/api/collect/save', async (req: Request, res: Response) => {
  try {
    const { data } = req.body
    data.extra.uuid = Date.now()
    data.createdAt = dayjs().format('YYYY-MM-DD HH:mm')
    const collects = getCollects()
    collects.unshift(data)
    fs.writeFileSync(PATHS.collect, JSON.stringify(collects))
    sendMail().catch((e) => {
      console.log(e.message)
    })
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
    return
  }
  res.json({
    message: 'OK',
  })
})

app.post('/api/web/info', async (req: Request, res: Response) => {
  try {
    let url = req.body.url
    if (url[0] === SELF_SYMBOL) {
      url = url.slice(1)
    }
    const data: any = await getWebInfo(url, {
      timeout: 0,
    })
    res.json({
      title: data.title,
      description: data.description,
      url: data.iconUrl,
      message: data.errorMsg,
    })
  } catch (error) {
    res.status(500).json({
      message: (error as Error).message,
    })
  }
})

app.post('/api/translate', async (req: Request, res: Response) => {
  const { content, language } = req.body

  try {
    const token = getConfigJson().XFAPIPassword
    if (!token) {
      const { data } = await axios.post(
        `${HTTP_BASE_URL}/api/translate`,
        req.body
      )
      res.json(data)
      return
    }

    const { data } = await axios.post(
      'https://spark-api-open.xf-yun.com/v1/chat/completions',
      {
        model: 'lite',
        messages: [
          {
            role: 'user',
            content: `${content} 翻译${
              language === 'zh-CN' ? '中文' : '英文'
            }，直接返回翻译的内容，如果不能翻译返回原内容`,
          },
        ],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )

    res.json({
      content: data.choices[0].message.content,
    })
    return
  } catch (error: any) {
    res.status(500).json({
      message: error.message,
    })
  }
})

app.listen(PORT, () => {
  console.log(`Server is running on port :${PORT}`)
})
