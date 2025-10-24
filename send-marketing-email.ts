import cloud from '@lafjs/cloud'
import * as nodemailer from 'nodemailer'

const db = cloud.database()

// 邮箱账户池配置
const emailAccounts = [
  // 163邮箱账户
  {
    type: '163',
    host: 'smtp.163.com',
    port: 465,
    secure: true,
    user: 'yuruotong1@163.com',
    pass: 'SNK9Wfndtrwp6sT2',
    name: '译源翻译',
    isActive: true // 账户是否可用
  },
  // QQ邮箱账户1
  {
    type: 'qq',
    host: 'smtp.qq.com',
    port: 587,
    secure: false,
    user: '2032569127@qq.com',
    pass: 'okzenkjaklstbfff',
    name: '译源翻译',
    isActive: true
  },
  // QQ邮箱账户2
  {
    type: 'qq',
    host: 'smtp.qq.com',
    port: 587,
    secure: false,
    user: '1256305343@qq.com',
    pass: 'ekxjzxnzdmjfbabg',
    name: '译源翻译',
    isActive: true
  }
]

// 当前使用的账户索引
let currentAccountIndex = 0

export default async function (ctx: FunctionContext) {
  try {
    // 兼容多种请求体格式
    let body = ctx.body || ctx.request?.body || {}
    
    // 如果 body 是字符串，尝试解析 JSON
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch (e) {
        console.error('JSON 解析失败:', e)
        body = {}
      }
    }
    
    console.log('接收到的 ctx.body:', ctx.body)
    console.log('接收到的 ctx.request?.body:', ctx.request?.body)
    console.log('解析后的 body:', body)
    
    const { subject, htmlContent, testMode, testEmails, testEmail } = body

    // 参数验证
    if (!subject || !htmlContent) {
      return {
        success: false,
        code: 400,
        message: '邮件主题和内容不能为空'
      }
    }

    // 测试模式：发送给指定的多个邮箱
    if (testMode) {
      // 支持新版（testEmails数组）和旧版（testEmail单个）
      let emails: string[] = []
      
      if (testEmails && Array.isArray(testEmails)) {
        emails = testEmails
      } else if (testEmail) {
        emails = [testEmail]
      } else {
        return {
          success: false,
          code: 400,
          message: '测试模式下必须提供测试邮箱'
        }
      }

      if (emails.length === 0) {
        return {
          success: false,
          code: 400,
          message: '测试模式下必须提供至少一个测试邮箱'
        }
      }

      // 验证邮箱格式
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      const invalidEmails = emails.filter(email => !emailRegex.test(email))
      if (invalidEmails.length > 0) {
        return {
          success: false,
          code: 400,
          message: `以下邮箱格式不正确: ${invalidEmails.join(', ')}`
        }
      }

      // 发送给所有测试邮箱
      const results = {
        total: emails.length,
        success: 0,
        failed: 0,
        details: [] as string[]
      }

      console.log(`📧 测试模式：准备发送给 ${emails.length} 个邮箱`)

      for (let i = 0; i < emails.length; i++) {
        const email = emails[i]
        console.log(`📧 [测试] 发送第 ${i + 1}/${emails.length} 封到: ${email}`)
        
        const result = await sendMarketingEmail(email, subject, htmlContent)

        if (result.success) {
          results.success++
          results.details.push(`✅ ${email} - 发送成功`)
          console.log(`✅ 测试邮件发送成功: ${email}`)
        } else {
          results.failed++
          results.details.push(`❌ ${email} - ${result.error || '发送失败'}`)
          console.log(`❌ 测试邮件发送失败: ${email} - ${result.error}`)
        }

        // 每封邮件间隔1秒
        if (i < emails.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      return {
        success: true,
        code: 200,
        message: `测试邮件发送完成：成功 ${results.success}/${results.total}`,
        data: {
          mode: 'test',
          total: results.total,
          success: results.success,
          failed: results.failed,
          recipients: emails,
          details: results.details
        }
      }
    }

    // 正式模式：获取所有用户邮箱
    let userEmails: string[] = []

    try {
      // 方法1：从你的API获取用户信息
      const response = await fetch('https://dray3mu49t.hzh.sealos.run/chatgpt-get-email')
      const users = await response.json()

      if (Array.isArray(users)) {
        // chatgpt-get-email 返回的已经是邮箱字符串数组，直接使用
        userEmails = users.filter(Boolean)
      }
    } catch (error) {
      console.error('从API获取用户失败，尝试从数据库获取:', error)

      // 方法2：如果API失败，尝试从数据库获取
      try {
        const usersData = await db.collection('users').get()
        userEmails = usersData.data.map(user => user.email).filter(Boolean)
      } catch (dbError) {
        console.error('从数据库获取用户失败:', dbError)
      }
    }

    if (userEmails.length === 0) {
      return {
        success: false,
        code: 404,
        message: '未找到任何用户邮箱'
      }
    }

    // 去重
    userEmails = [...new Set(userEmails)]

    // 批量发送邮件
    const results = {
      total: userEmails.length,
      success: 0,
      failed: 0,
      errors: [] as Array<{ email: string; error: string }>
    }

    // 账户轮询发送，每个账户发送后等待1分钟
    const accountDelay = 60000 // 1分钟间隔
    
    // 重置所有账户状态
    emailAccounts.forEach(account => account.isActive = true)

    for (let i = 0; i < userEmails.length; i++) {
      const email = userEmails[i]
      
      // 获取下一个可用账户
      const account = await getNextAvailableAccount()
      
      // 如果所有账户都不可用，等待到第二天
      if (!account) {
        console.log(`⚠️ 所有邮箱账户都已达到限制`)
        const waitTime = getMillisecondsUntilMidnight()
        console.log(`⏰ 等待到明天 0:00 继续发送... (约 ${Math.round(waitTime / 1000 / 60)} 分钟)`)
        
        await new Promise(resolve => setTimeout(resolve, waitTime))
        
        // 重置所有账户状态
        console.log(`🌅 新的一天开始，重置所有账户状态...`)
        emailAccounts.forEach(account => account.isActive = true)
        currentAccountIndex = 0
        
        // 重新获取可用账户
        const retryAccount = await getNextAvailableAccount()
        if (!retryAccount) {
          console.log(`❌ 重试后仍无可用账户，跳过此邮件`)
          results.failed++
          results.errors.push({ email, error: '无可用邮箱账户' })
          continue
        }
      }
      
      const currentAccount = account || emailAccounts[currentAccountIndex]
      
      try {
        console.log(`📧 正在发送第 ${i + 1}/${userEmails.length} 封`)
        console.log(`   使用账户: ${currentAccount.user} (${currentAccount.type})`)
        console.log(`   收件人: ${email}`)
        
        const result = await sendMarketingEmailWithAccount(email, subject, htmlContent, currentAccount)
        
        if (result.success) {
          results.success++
          console.log(`✅ 发送成功 (总计: ${results.success}/${userEmails.length})`)
          
          // 切换到下一个账户
          currentAccountIndex = (currentAccountIndex + 1) % emailAccounts.length
          
          // 如果不是最后一封，等待1分钟后使用下一个账户
          if (i < userEmails.length - 1) {
            console.log(`⏱️ 等待1分钟后使用下一个账户发送...`)
            await new Promise(resolve => setTimeout(resolve, accountDelay))
          }
        } else if (result.isFrequencyLimit || result.isAuthError) {
          // 账户出错，标记为不可用
          console.log(`⚠️ 账户 ${currentAccount.user} 出错: ${result.error}`)
          currentAccount.isActive = false
          console.log(`🚫 已禁用账户 ${currentAccount.user}，切换到下一个账户`)
          
          // 切换到下一个账户并重试当前邮件
          currentAccountIndex = (currentAccountIndex + 1) % emailAccounts.length
          i-- // 重试当前邮件
          continue
        } else {
          results.failed++
          results.errors.push({ email, error: result.error || '发送失败' })
          console.log(`❌ 发送失败: ${email} - ${result.error}`)
          
          // 即使失败也切换账户
          currentAccountIndex = (currentAccountIndex + 1) % emailAccounts.length
          
          if (i < userEmails.length - 1) {
            console.log(`⏱️ 等待1分钟后使用下一个账户...`)
            await new Promise(resolve => setTimeout(resolve, accountDelay))
          }
        }
      } catch (error) {
        results.failed++
        results.errors.push({ email, error: error.message })
        console.log(`❌ 发送错误: ${email} - ${error.message}`)
        
        // 切换到下一个账户
        currentAccountIndex = (currentAccountIndex + 1) % emailAccounts.length
        
        if (i < userEmails.length - 1) {
          console.log(`⏱️ 等待1分钟后使用下一个账户...`)
          await new Promise(resolve => setTimeout(resolve, accountDelay))
        }
      }
    }

    // 记录发送历史
    await db.collection('email_marketing_logs').add({
      subject: subject,
      sentAt: new Date().toISOString(),
      totalRecipients: results.total,
      successCount: results.success,
      failedCount: results.failed,
      mode: 'production'
    })

    return {
      success: true,
      code: 200,
      message: `营销邮件发送完成`,
      data: {
        mode: 'production',
        total: results.total,
        success: results.success,
        failed: results.failed,
        errors: results.errors.slice(0, 10) // 只返回前10个错误
      }
    }

  } catch (error) {
    console.error('营销邮件发送错误:', error)
    return {
      success: false,
      code: 500,
      message: '服务器内部错误: ' + error.message
    }
  }
}

// 使用指定账户发送邮件
async function sendMarketingEmailWithAccount(
  email: string,
  subject: string,
  htmlContent: string,
  account: any
): Promise<{ success: boolean; isFrequencyLimit?: boolean; isAuthError?: boolean; error?: string }> {
  try {
    // 创建邮件传输配置
    const transporter = nodemailer.createTransport({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: {
        user: account.user,
        pass: account.pass
      },
      tls: {
        rejectUnauthorized: false
      }
    })

    // 邮件内容配置
    const mailOptions = {
      from: {
        name: account.name,
        address: account.user
      },
      to: email,
      subject: subject,
      html: htmlContent
    }

    // 发送邮件
    const info = await transporter.sendMail(mailOptions)
    console.log(`营销邮件发送成功 - ${email}: ${info.messageId}`)

    return { success: true }

  } catch (error: any) {
    console.error(`邮件发送错误 - ${email}:`, error)
    
    // 检测是否是频率限制错误（535错误码）
    const isFrequencyLimit = 
      error.responseCode === 535 && 
      (error.response?.includes('login frequency limited') || 
       error.response?.includes('Login fail') ||
       error.response?.includes('service is not open'))
    
    // 检测是否是认证错误
    const isAuthError = 
      error.code === 'EAUTH' || 
      (error.responseCode === 535 && error.response?.includes('password is incorrect'))
    
    if (isFrequencyLimit) {
      console.log(`⚠️ 检测到频率限制: ${error.response}`)
      return { 
        success: false, 
        isFrequencyLimit: true,
        error: '邮箱发送频率受限' 
      }
    }
    
    if (isAuthError) {
      console.log(`⚠️ 检测到认证错误: ${error.response}`)
      return {
        success: false,
        isAuthError: true,
        error: '邮箱认证失败'
      }
    }
    
    return { 
      success: false, 
      error: error.message || '发送失败' 
    }
  }
}

// 获取下一个可用账户
async function getNextAvailableAccount(): Promise<any | null> {
  const activeAccounts = emailAccounts.filter(account => account.isActive)
  
  if (activeAccounts.length === 0) {
    return null
  }
  
  // 从当前索引开始查找可用账户
  let attempts = 0
  while (attempts < emailAccounts.length) {
    const account = emailAccounts[currentAccountIndex]
    if (account.isActive) {
      return account
    }
    currentAccountIndex = (currentAccountIndex + 1) % emailAccounts.length
    attempts++
  }
  
  return null
}

// 兼容旧函数（测试模式使用）
async function sendMarketingEmail(
  email: string,
  subject: string,
  htmlContent: string
): Promise<{ success: boolean; isFrequencyLimit?: boolean; error?: string }> {
  // 使用第一个可用账户
  const account = emailAccounts.find(acc => acc.isActive) || emailAccounts[0]
  return sendMarketingEmailWithAccount(email, subject, htmlContent, account)
}

// 计算到明天0点的毫秒数
function getMillisecondsUntilMidnight(): number {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)
  return tomorrow.getTime() - now.getTime()
}

