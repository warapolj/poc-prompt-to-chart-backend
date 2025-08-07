import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from '@langchain/google-genai'
import { z } from 'zod'
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import { MemoryVectorStore } from 'langchain/vectorstores/memory'
import { RetrievalQAChain } from 'langchain/chains'
import { streamSSE } from 'hono/streaming'
import { cors } from 'hono/cors'
import mysql from 'mysql2/promise'
import 'dotenv/config'

// Import chart configuration
import {
  formatDataForShadcn,
  generateShadcnChartResponse,
  type ChartType,
} from '../packages/chart-config.js'

// Database configuration
const dbConfig = {
  host: 'localhost',
  port: 3306,
  user: 'poc_user',
  password: 'poc_password',
  database: 'poc_chart_db',
}

// Function to get available tables in database
async function getAvailableTables() {
  let connection
  try {
    connection = await mysql.createConnection(dbConfig)

    const [tables] = await connection.execute(
      `SELECT TABLE_NAME as table_name, TABLE_COMMENT as table_comment 
       FROM INFORMATION_SCHEMA.TABLES 
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [dbConfig.database],
    )

    return (tables as any[]).map((table) => ({
      name: table.table_name,
      comment: table.table_comment || 'ไม่มีคำอธิบาย',
    }))
  } catch (error) {
    console.error('Error getting available tables:', error)
    return [{ name: 'olympic_medalists', comment: 'ข้อมูลเหรียญโอลิมปิก' }]
  } finally {
    if (connection) {
      await connection.end()
    }
  }
}

// Function to auto-detect best table for query
async function detectBestTable(userQuery: string, availableTables: any[]) {
  const query = userQuery.toLowerCase()

  // Keywords mapping for different types of data
  const tableKeywords = {
    olympic: [
      'เหรียญ',
      'โอลิมปิก',
      'กีฬา',
      'นักกีฬา',
      'ประเทศ',
      'ทอง',
      'เงิน',
      'ทองแดง',
      'medal',
      'olympic',
      'sport',
      'athlete',
      'country',
    ],
    sales: [
      'ขาย',
      'รายได้',
      'ลูกค้า',
      'สินค้า',
      'การขาย',
      'sale',
      'revenue',
      'customer',
      'product',
    ],
    employee: ['พนักงาน', 'ลูกค้า', 'เงินเดือน', 'แผนก', 'employee', 'salary', 'department'],
    order: ['สั่งซื้อ', 'คำสั่งซื้อ', 'ออเดอร์', 'order', 'purchase'],
    user: ['ผู้ใช้', 'สมาชิก', 'user', 'member', 'account'],
  }

  // Score each table based on keywords and table name
  const tableScores = availableTables.map((table) => {
    let score = 0
    const tableName = table.name.toLowerCase()
    const tableComment = (table.comment || '').toLowerCase()

    // Check if query keywords match table name or comment
    for (const [category, keywords] of Object.entries(tableKeywords)) {
      const keywordMatches = keywords.filter(
        (keyword) =>
          query.includes(keyword) &&
          (tableName.includes(category) || tableComment.includes(keyword)),
      ).length
      score += keywordMatches * 10
    }

    // Direct table name match
    if (query.includes(tableName)) {
      score += 50
    }

    // Partial table name match
    const tableWords = tableName.split('_')
    tableWords.forEach((word: string) => {
      if (query.includes(word)) {
        score += 20
      }
    })

    return { table, score }
  })

  // Sort by score and return best match
  tableScores.sort((a, b) => b.score - a.score)

  // If no good match found, return first table or fallback
  return (
    tableScores[0]?.table ||
    availableTables[0] || { name: 'olympic_medalists', comment: 'Fallback table' }
  )
}

// Function to get sample data for AI learning (dynamic for any table)
async function getSampleData(tableName: string, availableColumns: any[], limit: number = 10) {
  let connection
  try {
    connection = await mysql.createConnection(dbConfig)

    // Ensure limit is a safe integer to prevent SQL injection
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit))) // Clamp between 1 and 100

    // Get sample records - use string interpolation for LIMIT as MySQL doesn't support parameter placeholders for LIMIT
    const [sampleRows] = await connection.execute(`SELECT * FROM ${tableName} LIMIT ${safeLimit}`)

    // Dynamically get distinct values for categorical columns
    const distinctValues: any = {}

    // Filter categorical columns (text-based and groupable)
    const categoricalColumns = availableColumns
      .filter((col) => col.canBeGrouped && col.isText && !col.name.includes('id'))
      .slice(0, 5) // Limit to 5 columns to avoid too many queries

    // Get distinct values for each categorical column
    for (const col of categoricalColumns) {
      try {
        const [distinctRows] = await connection.execute(
          `SELECT DISTINCT ${col.name} FROM ${tableName} WHERE ${col.name} IS NOT NULL LIMIT 5`,
        )
        distinctValues[col.name] = (distinctRows as any[]).map((row) => row[col.name])
      } catch (error) {
        console.warn(`Could not get distinct values for column ${col.name}:`, error)
        distinctValues[col.name] = []
      }
    }

    return {
      sampleRecords: sampleRows as any[],
      distinctValues,
      categoricalColumns: categoricalColumns.map((col) => col.name),
      totalSampleCount: (sampleRows as any[]).length,
    }
  } catch (error) {
    console.error('Error getting sample data:', error)
    return {
      sampleRecords: [],
      distinctValues: {
        fallback: ['Sample1', 'Sample2', 'Sample3'],
      },
      categoricalColumns: ['fallback'],
      totalSampleCount: 0,
    }
  } finally {
    if (connection) {
      await connection.end()
    }
  }
}

// Function to generate SQL query using AI with dynamic rules
async function generateSQLQueryWithAI(
  columnAnalysis: any,
  userQuery: string,
  availableColumns: any[],
  sampleData: any,
  tableName: string = 'olympic_medalists',
) {
  const analysisModel = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.1,
  })

  // สร้าง metadata เชิงลึกของ columns
  const columnsMetadata = availableColumns.map((col) => {
    const isNumeric = ['int', 'bigint', 'decimal', 'float', 'double'].includes(
      col.type.toLowerCase(),
    )
    const isDate = ['date', 'datetime', 'timestamp', 'year'].includes(col.type.toLowerCase())
    const isText = ['varchar', 'text', 'char'].includes(col.type.toLowerCase())

    return {
      name: col.name,
      type: col.type,
      comment: col.comment || 'ไม่มีคำอธิบาย',
      isNumeric,
      isDate,
      isText,
      canBeGrouped: isText || isDate || col.name.includes('code'),
      canBeAggregated: isNumeric,
      suitableForFilter: true,
    }
  })

  const columnsInfo = columnsMetadata
    .map(
      (col) =>
        `${col.name} (${col.type}): ${col.comment} [Groupable: ${col.canBeGrouped}, Aggregatable: ${col.canBeAggregated}]`,
    )
    .join('\n')

  // วิเคราะห์ chart type เพื่อกำหนดรูปแบบ query
  const chartQueryPatterns: Record<string, string> = {
    bar: 'SELECT {category_column}, COUNT(*) AS count FROM {table} {where_clause} GROUP BY {category_column} ORDER BY count DESC {limit_clause}',
    column:
      'SELECT {category_column}, COUNT(*) AS count FROM {table} {where_clause} GROUP BY {category_column} ORDER BY count DESC {limit_clause}',
    line: 'SELECT {time_column}, COUNT(*) AS count FROM {table} {where_clause} GROUP BY {time_column} ORDER BY {time_column} ASC',
    pie: 'SELECT {category_column}, COUNT(*) AS count FROM {table} {where_clause} GROUP BY {category_column} ORDER BY count DESC LIMIT 8',
    area: 'SELECT {time_column}, COUNT(*) AS count FROM {table} {where_clause} GROUP BY {time_column} ORDER BY {time_column} ASC',
    scatter: 'SELECT {x_column}, {y_column} FROM {table} {where_clause} {limit_clause}',
    histogram:
      'SELECT {numeric_column}, COUNT(*) AS frequency FROM {table} {where_clause} GROUP BY {numeric_column} ORDER BY {numeric_column}',
    donut:
      'SELECT {category_column}, COUNT(*) AS count FROM {table} {where_clause} GROUP BY {category_column} ORDER BY count DESC LIMIT 10',
  }

  const selectedPattern = chartQueryPatterns[columnAnalysis.chart_type] || chartQueryPatterns['bar']

  const sqlPrompt = `
  สร้าง SQL query แบบ dynamic สำหรับข้อมูลในตาราง "${tableName}" ตามการวิเคราะห์ต่อไปนี้:

  คำถามผู้ใช้: "${userQuery}"
  
  ผลการวิเคราะห์:
  - Columns ที่ต้องใช้: ${columnAnalysis.required_columns.join(', ')}
  - Chart type: ${columnAnalysis.chart_type}
  - Data aggregation: ${columnAnalysis.data_aggregation}
  - X axis: ${columnAnalysis.x_axis}
  - Y axis: ${columnAnalysis.y_axis}

  Columns ที่มีในตาราง ${tableName}:
  ${columnsInfo}

  ตัวอย่างข้อมูลจริงในตาราง (${sampleData.totalSampleCount} รายการ):
  ${sampleData.sampleRecords
    .slice(0, 3)
    .map(
      (record: any, index: number) =>
        `Record ${index + 1}: ${Object.entries(record)
          .map(([key, value]) => `${key}="${value}"`)
          .join(', ')}`,
    )
    .join('\n  ')}

  ค่า Distinct ในแต่ละ column สำคัญ:
  ${Object.entries(sampleData.distinctValues)
    .map(
      ([columnName, values]: [string, any]) =>
        `- ${columnName}: ${Array.isArray(values) ? values.slice(0, 5).join(', ') : 'N/A'}${
          Array.isArray(values) && values.length > 5 ? '...' : ''
        }`,
    )
    .join('\n  ')}

  Categorical Columns ที่พร้อมใช้งาน: ${sampleData.categoricalColumns.join(', ')}

  รูปแบบ Query สำหรับ ${columnAnalysis.chart_type} chart:
  ${selectedPattern}

  กฎการสร้าง SQL (Dynamic Rules พร้อมตัวอย่างข้อมูลจริง):
  
  ## พื้นฐานการสร้าง Query:
  1. ใช้เฉพาะ columns ที่มีในตารางที่ระบุ
  2. วิเคราะห์ประเภทข้อมูลของแต่ละ column เพื่อเลือกการประมวลผลที่เหมาะสม
  3. ใช้ alias ที่เหมาะสมสำหรับ SELECT clause
  4. อ้างอิงตัวอย่างข้อมูลจริงข้างต้นเพื่อเข้าใจรูปแบบข้อมูล
  
  ## รูปแบบ Query ตาม Chart Type:
  - **Categorical Charts (bar/column/pie)**: SELECT [category_column], COUNT(*) AS count FROM [table] GROUP BY [category_column]
  - **Time Series Charts (line/area)**: SELECT [time_column], [aggregation] FROM [table] GROUP BY [time_column] ORDER BY [time_column]
  - **Distribution Charts (histogram)**: SELECT [numeric_column], COUNT(*) AS frequency FROM [table] GROUP BY [numeric_column]
  - **Comparison Charts (scatter)**: SELECT [x_column], [y_column] FROM [table]
  
  ## Dynamic WHERE Clause Construction (ใช้ตัวอย่างข้อมูลจริง):
  - วิเคราะห์คำถามเพื่อหา filter conditions
  - ใช้ค่า distinct จากตัวอย่างข้อมูลเพื่อสร้าง condition ที่ถูกต้อง
  - เช่น ถ้าหา "ไทย" ใช้ WHERE country = 'Thailand' หรือ country_code = 'THA'
  - เช่น ถ้าหา "ทอง" ใช้ WHERE medal = 'Gold'
  - เช่น ถ้าหาปี ใช้ WHERE year = 2024 หรือ year BETWEEN 2020 AND 2024
  - รองรับ multiple conditions ด้วย AND/OR
  
  ## Aggregation Strategy:
  - **COUNT(*)**: สำหรับนับจำนวนรายการ
  - **SUM()**: สำหรับรวมค่าตัวเลข
  - **AVG()**: สำหรับค่าเฉลี่ย
  - **MAX()/MIN()**: สำหรับค่าสูงสุด/ต่ำสุด
  
  ## Ordering และ Limiting:
  - **Categorical data**: ORDER BY count DESC (หรือตาม value ที่เหมาะสม)
  - **Time series**: ORDER BY time_column ASC
  - **LIMIT**: ปรับตาม chart type และข้อมูล (10-50 รายการ)
  
  ## ตัวอย่างการใช้ข้อมูลจริงในการสร้าง WHERE clause:
  ${Object.entries(sampleData.distinctValues)
    .map(([columnName, values]: [string, any]) => {
      if (!Array.isArray(values) || values.length === 0) return ''
      const examples = values.slice(0, 2)
      return `- ถ้าหา "${examples[0]}" → WHERE ${columnName} = '${examples[0]}'${
        examples[1] ? ` หรือ WHERE ${columnName} = '${examples[1]}'` : ''
      }`
    })
    .filter(Boolean)
    .join('\n  ')}
  - ถ้าหาช่วงปีหรือตัวเลข → WHERE column_name BETWEEN value1 AND value2
  - ถ้าหาหลายเงื่อนไข → WHERE condition1 AND condition2

  วิเคราะห์คำถามอย่างละเอียดและสร้าง SQL ที่:
  1. ใช้ columns ที่เหมาะสมจาก analysis
  2. สร้าง WHERE clause ที่ตรงกับความต้องการและใช้ค่าจริงจากตัวอย่างข้อมูล
  3. เลือก aggregation ที่เหมาะสมกับข้อมูล
  4. กำหนด ORDER BY และ LIMIT ที่เหมาะสม

  ตอบกลับเป็น JSON object เท่านั้น:
  {
    "sql_query": "SELECT ... FROM ${tableName} WHERE ... GROUP BY ... ORDER BY ... LIMIT ...",
    "explanation": "คำอธิบายละเอียดว่าทำไมสร้าง query นี้ รวมถึงการเลือก columns, WHERE conditions, และ aggregation strategy",
    "query_reasoning": "เหตุผลเชิงเทคนิคของการออกแบบ query นี้ โดยอ้างอิงตัวอย่างข้อมูลจริง",
    "columns_used": ["column1", "column2"],
    "filters_applied": ["filter description"],
    "chart_suitability": "อธิบายว่า query นี้เหมาะสมกับ chart type อย่างไร",
    "sample_data_insights": "ข้อมูลเชิงลึกที่ได้จากการวิเคราะห์ตัวอย่างข้อมูล"
  }
  `

  try {
    const sqlResult = await analysisModel.invoke(sqlPrompt)

    // แปลง content เป็น string และหา JSON
    const contentString =
      typeof sqlResult.content === 'string' ? sqlResult.content : JSON.stringify(sqlResult.content)

    const jsonMatch = contentString.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        sqlQuery: parsed.sql_query,
        explanation: parsed.explanation,
        queryReasoning: parsed.query_reasoning || '',
        columnsUsed: parsed.columns_used || [],
        filtersApplied: parsed.filters_applied || [],
        chartSuitability: parsed.chart_suitability || '',
        sampleDataInsights: parsed.sample_data_insights || '',
      }
    }
  } catch (error) {
    console.error('Error generating SQL with AI:', error)
  }

  // Enhanced fallback query based on analysis
  const fallbackColumns = columnAnalysis.required_columns || ['country', 'medal']
  const primaryColumn = fallbackColumns[0] || 'country'

  return {
    sqlQuery: `
      SELECT ${primaryColumn}, COUNT(*) as count
      FROM ${tableName} 
      GROUP BY ${primaryColumn}
      ORDER BY count DESC
      LIMIT 15
    `.trim(),
    explanation: `Fallback query: นับจำนวนรายการตาม ${primaryColumn} และเรียงลำดับจากมากไปน้อย`,
    queryReasoning: 'ใช้ fallback query เนื่องจาก AI generation ล้มเหลว',
    columnsUsed: [primaryColumn],
    filtersApplied: ['ไม่มี filter'],
    chartSuitability: `เหมาะสำหรับ ${columnAnalysis.chart_type} chart พื้นฐาน`,
    sampleDataInsights: 'ใช้ fallback query ไม่ได้วิเคราะห์จากตัวอย่างข้อมูล',
  }
}

// Helper function to better handle data parsing and transformation
function parseQueryResultToChartData(queryResult: any[], columnAnalysis: any) {
  if (!queryResult || queryResult.length === 0) {
    return []
  }

  return queryResult.map((row, index) => {
    const keys = Object.keys(row)

    // Improved value key detection
    const valueKey =
      keys.find((key) => {
        const lowKey = key.toLowerCase()
        return (
          lowKey.includes('count') ||
          lowKey.includes('value') ||
          lowKey.includes('total') ||
          lowKey.includes('sum') ||
          lowKey.includes('amount') ||
          lowKey.includes('number') ||
          lowKey.includes('frequency') ||
          lowKey.includes('medal_count') ||
          lowKey === 'y' ||
          // Check if the value is numeric
          (typeof row[key] === 'number' && !lowKey.includes('year') && !lowKey.includes('id'))
        )
      }) || keys[keys.length - 1]

    // Handle multi-dimensional data
    const labelKeys = keys.filter((key) => key !== valueKey)
    let labelValue = ''

    if (labelKeys.length === 1) {
      labelValue = row[labelKeys[0]]?.toString() || 'Unknown'
    } else if (labelKeys.length > 1) {
      // For multi-dimensional data like year + medal, create meaningful labels
      labelValue = labelKeys.map((key) => row[key]?.toString() || '').join(' - ')
    } else {
      labelValue = `Item ${index + 1}`
    }

    // Enhanced value parsing
    let parsedValue = 0
    const rawValue = row[valueKey]

    if (typeof rawValue === 'number') {
      parsedValue = rawValue
    } else if (typeof rawValue === 'string') {
      const numValue = parseFloat(rawValue)
      parsedValue = isNaN(numValue) ? 0 : numValue
    }

    return {
      label: labelValue,
      value: parsedValue,
      additional_info: row,
    }
  })
}

// Function to execute SQL query
async function executeQuery(sqlQuery: string, params: any[] = []) {
  let connection
  try {
    connection = await mysql.createConnection(dbConfig)
    const [rows] = await connection.execute(sqlQuery, params)
    return rows as any[]
  } catch (error) {
    console.error('Error executing query:', error)
    throw error
  } finally {
    if (connection) {
      await connection.end()
    }
  }
}

// Function to verify query results with AI analysis
async function verifyQueryResultsWithAI(
  originalPrompt: string,
  sqlQuery: string,
  queryResults: any[],
  columnAnalysis: any,
  availableColumns: any[],
  tableName: string,
) {
  const verificationModel = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.1,
  })

  const verificationPrompt = `
  ตรวจสอบความถูกต้องของผลลัพธ์ SQL Query ต่อไปนี้:

  คำถามต้นฉบับของผู้ใช้: "${originalPrompt}"
  
  SQL Query ที่สร้าง: 
  ${sqlQuery}
  
  ผลลัพธ์ที่ได้ (${queryResults.length} รายการ):
  ${queryResults
    .slice(0, 10)
    .map(
      (row, index) =>
        `${index + 1}. ${Object.entries(row)
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ')}`,
    )
    .join('\n')}
  ${queryResults.length > 10 ? `... และอีก ${queryResults.length - 10} รายการ` : ''}

  การวิเคราะห์เดิม:
  - Chart type: ${columnAnalysis.chart_type}
  - Columns ที่ใช้: ${columnAnalysis.required_columns?.join(', ')}
  - X axis: ${columnAnalysis.x_axis}
  - Y axis: ${columnAnalysis.y_axis}

  Columns ที่มีในตาราง ${tableName}:
  ${availableColumns
    .map((col) => `- ${col.name} (${col.type}): ${col.comment || 'ไม่มีคำอธิบาย'}`)
    .join('\n')}

  วิเคราะห์และตรวจสอบ:
  1. ผลลัพธ์ตรงกับคำถามของผู้ใช้หรือไม่?
  2. SQL Query เหมาะสมและถูกต้องหรือไม่?
  3. ข้อมูลที่ได้มีความหมายและใช้งานได้หรือไม่?
  4. จำนวนผลลัพธ์เหมาะสมหรือไม่ (ไม่น้อยเกินไป ไม่มากเกินไป)?
  5. Chart type ที่เลือกเหมาะสมกับข้อมูลหรือไม่?

  ตอบกลับเป็น JSON object เท่านั้น:
  {
    "is_valid": true/false,
    "confidence_score": 0-100,
    "issues_found": ["รายการปัญหาที่พบ"],
    "suggestions": ["คำแนะนำในการปรับปรุง"],
    "should_retry": true/false,
    "improved_sql": "SQL query ที่ปรับปรุงแล้ว (ถ้ามี)",
    "reasoning": "เหตุผลในการตัดสินใจ",
    "data_quality": {
      "completeness": "การประเมินความครบถ้วน",
      "relevance": "การประเมินความเกี่ยวข้อง",
      "accuracy": "การประเมินความถูกต้อง"
    }
  }
  `

  try {
    const verificationResult = await verificationModel.invoke(verificationPrompt)

    // แปลง content เป็น string และหา JSON
    const contentString =
      typeof verificationResult.content === 'string'
        ? verificationResult.content
        : JSON.stringify(verificationResult.content)

    const jsonMatch = contentString.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        isValid: parsed.is_valid || false,
        confidenceScore: parsed.confidence_score || 0,
        issuesFound: parsed.issues_found || [],
        suggestions: parsed.suggestions || [],
        shouldRetry: parsed.should_retry || false,
        improvedSql: parsed.improved_sql || null,
        reasoning: parsed.reasoning || '',
        dataQuality: parsed.data_quality || {
          completeness: 'ไม่ทราบ',
          relevance: 'ไม่ทราบ',
          accuracy: 'ไม่ทราบ',
        },
      }
    }
  } catch (error) {
    console.error('Error in AI verification:', error)
  }

  // Fallback verification - basic checks
  return {
    isValid: queryResults.length > 0,
    confidenceScore: queryResults.length > 0 ? 70 : 30,
    issuesFound: queryResults.length === 0 ? ['ไม่พบข้อมูล'] : [],
    suggestions: queryResults.length === 0 ? ['ลองปรับเงื่อนไข WHERE หรือเปลี่ยน table'] : [],
    shouldRetry: queryResults.length === 0,
    improvedSql: null,
    reasoning: 'การตรวจสอบพื้นฐาน - AI verification ล้มเหลว',
    dataQuality: {
      completeness: queryResults.length > 0 ? 'ดี' : 'ต่ำ',
      relevance: 'ไม่ทราบ',
      accuracy: 'ไม่ทราบ',
    },
  }
}

// Function to improve and clarify user prompt using AI
async function improveUserPrompt(
  originalPrompt: string,
  availableColumns: any[],
  availableTables: any[],
  tableName: string,
) {
  const promptImprovementModel = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.1,
  })

  // สร้างข้อมูลบริบทสำหรับการปรับปรุง prompt
  const contextInfo = `
  ตาราง: ${tableName}
  Columns ที่มี: ${availableColumns.map((col) => `${col.name} (${col.type})`).join(', ')}
  Tables ทั้งหมดในระบบ: ${availableTables.map((table) => table.name).join(', ')}
  
  ประเภทข้อมูลหลัก:
  - Categorical: ${availableColumns
    .filter((col) => col.canBeGrouped && col.isText)
    .map((col) => col.name)
    .join(', ')}
  - Numeric: ${availableColumns
    .filter((col) => col.isNumeric)
    .map((col) => col.name)
    .join(', ')}
  - Date/Time: ${availableColumns
    .filter((col) => col.isDate)
    .map((col) => col.name)
    .join(', ')}
  `

  const improvementPrompt = `
  ช่วยปรับปรุงและทำให้คำถามของผู้ใช้ชัดเจนขึ้น เพื่อให้ AI สามารถสร้าง SQL และกราฟได้ตรงตามความต้องการมากขึ้น:

  คำถามต้นฉบับ: "${originalPrompt}"

  ข้อมูลบริบท:
  ${contextInfo}

  เป้าหมายการปรับปรุง:
  1. ระบุประเภทกราฟที่ต้องการ (ถ้าไม่ชัดเจน)
  2. ชี้แจงข้อมูลที่ต้องการวิเคราะห์
  3. เพิ่มรายละเอียดการกรองข้อมูล (filters)
  4. ระบุช่วงเวลา หรือเงื่อนไขเฉพาะ
  5. ปรับให้เหมาะสมกับข้อมูลที่มีอยู่จริง

  หลักการปรับปรุง:
  - เก็บความหมายเดิมของคำถาม
  - เพิ่มความชัดเจนและรายละเอียด
  - ใช้ศัพท์ที่ตรงกับ columns ที่มีอยู่
  - แนะนำประเภทกราฟที่เหมาะสม
  - เพิ่ม context ที่จำเป็น

  ตัวอย่างการปรับปรุง:
  - "เหรียญของไทย" → "แสดงจำนวนเหรียญทั้งหมดของประเทศไทย แยกตามประเภทเหรียญ (ทอง, เงิน, ทองแดง) ในรูปแบบกราฟแท่ง"
  - "กีฬาแต่ละปี" → "แสดงจำนวนเหรียญในแต่ละกีฬาตลอดปี 2020-2024 ในรูปแบบกราฟเส้น"
  - "เปรียบเทียบประเทศ" → "เปรียบเทียบจำนวนเหรียญรวมของ 10 ประเทศที่ได้เหรียญมากที่สุด ในรูปแบบกราฟแท่ง"

  ตอบกลับเป็น JSON object เท่านั้น:
  {
    "improved_prompt": "คำถามที่ปรับปรุงแล้ว",
    "improvements_made": ["รายการการปรับปรุงที่ทำ"],
    "suggested_chart_type": "ประเภทกราฟที่แนะนำ",
    "key_insights": "ข้อมูลเชิงลึกที่คาดว่าจะได้",
    "data_focus": "จุดเน้นของข้อมูลที่จะวิเคราะห์",
    "filter_suggestions": ["เงื่อนไขการกรองที่แนะนำ"],
    "reasoning": "เหตุผลในการปรับปรุง"
  }
  `

  try {
    const improvementResult = await promptImprovementModel.invoke(improvementPrompt)

    // แปลง content เป็น string และหา JSON
    const contentString =
      typeof improvementResult.content === 'string'
        ? improvementResult.content
        : JSON.stringify(improvementResult.content)

    const jsonMatch = contentString.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        improvedPrompt: parsed.improved_prompt || originalPrompt,
        improvementsMade: parsed.improvements_made || [],
        suggestedChartType: parsed.suggested_chart_type || null,
        keyInsights: parsed.key_insights || '',
        dataFocus: parsed.data_focus || '',
        filterSuggestions: parsed.filter_suggestions || [],
        reasoning: parsed.reasoning || '',
        wasImproved: parsed.improved_prompt !== originalPrompt,
      }
    }
  } catch (error) {
    console.error('Error improving user prompt:', error)
  }

  // Fallback - return original prompt with basic improvements
  return {
    improvedPrompt: originalPrompt,
    improvementsMade: ['ไม่สามารถปรับปรุงได้ - ใช้ prompt เดิม'],
    suggestedChartType: null,
    keyInsights: 'ไม่สามารถวิเคราะห์ได้',
    dataFocus: 'ข้อมูลทั่วไป',
    filterSuggestions: [],
    reasoning: 'AI improvement ล้มเหลว',
    wasImproved: false,
  }
}

// Function to execute query with AI verification and retry logic
async function executeQueryWithRetry(
  originalPrompt: string,
  columnAnalysis: any,
  availableColumns: any[],
  sampleData: any,
  tableName: string,
  maxRetries: number = 2,
) {
  let attempt = 0
  let lastResult = null
  let lastError = null
  let currentSqlData = null

  while (attempt <= maxRetries) {
    try {
      // Generate SQL query
      if (attempt === 0) {
        // First attempt - use original analysis
        currentSqlData = await generateSQLQueryWithAI(
          columnAnalysis,
          originalPrompt,
          availableColumns,
          sampleData,
          tableName,
        )
      } else {
        // Retry attempt - include feedback from previous verification
        const retryPrompt = `
        ${originalPrompt}
        
        RETRY ${attempt}/${maxRetries}:
        ปัญหาจากครั้งก่อน: ${
          lastResult?.verification?.issuesFound?.join(', ') || 'ผลลัพธ์ไม่เหมาะสม'
        }
        คำแนะนำ: ${lastResult?.verification?.suggestions?.join(', ') || 'ไม่มี'}
        ${
          lastResult?.verification?.improvedSql
            ? `SQL ที่แนะนำ: ${lastResult.verification.improvedSql}`
            : ''
        }
        `

        currentSqlData = await generateSQLQueryWithAI(
          columnAnalysis,
          retryPrompt,
          availableColumns,
          sampleData,
          tableName,
        )
      }

      // Execute the SQL query
      const queryResults = await executeQuery(currentSqlData.sqlQuery)

      // Verify results with AI
      const verification = await verifyQueryResultsWithAI(
        originalPrompt,
        currentSqlData.sqlQuery,
        queryResults,
        columnAnalysis,
        availableColumns,
        tableName,
      )

      const result = {
        success: true,
        queryResults,
        sqlData: currentSqlData,
        verification,
        attempt: attempt + 1,
        maxRetries,
      }

      // Check if result is acceptable
      if (verification.isValid && verification.confidenceScore >= 70) {
        return result
      }

      // If not valid and we should retry
      if (verification.shouldRetry && attempt < maxRetries) {
        lastResult = result
        attempt++
        continue
      }

      // Return current result even if not perfect
      return result
    } catch (error) {
      lastError = error
      console.error(`Query execution attempt ${attempt + 1} failed:`, error)

      if (attempt < maxRetries) {
        attempt++
        continue
      }

      // All attempts failed, return error result
      return {
        success: false,
        queryResults: [],
        sqlData: currentSqlData || {
          sqlQuery: 'SELECT "Error" as message',
          explanation: 'เกิดข้อผิดพลาดในการสร้าง SQL',
        },
        verification: {
          isValid: false,
          confidenceScore: 0,
          issuesFound: [
            `เกิดข้อผิดพลาด: ${lastError instanceof Error ? lastError.message : 'Unknown error'}`,
          ],
          suggestions: ['ลองเปลี่ยนคำถามหรือตรวจสอบข้อมูล'],
          shouldRetry: false,
          reasoning: 'เกิดข้อผิดพลาดในการ execute query หลายครั้ง',
        },
        attempt: attempt + 1,
        maxRetries,
        error: lastError,
      }
    }
  }
}

// Helper function to analyze table structure dynamically
async function analyzeTableStructure(tableName: string) {
  let connection
  try {
    connection = await mysql.createConnection(dbConfig)

    const [rows] = await connection.execute(
      `
      SELECT 
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        COLUMN_COMMENT as column_comment,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        CHARACTER_MAXIMUM_LENGTH as max_length
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      AND COLUMN_NAME NOT IN ('id', 'created_at', 'updated_at')
      ORDER BY ORDINAL_POSITION
    `,
      [dbConfig.database, tableName],
    )

    return (rows as any[]).map((row) => {
      const isNumeric = [
        'int',
        'bigint',
        'decimal',
        'float',
        'double',
        'tinyint',
        'smallint',
        'mediumint',
      ].includes(row.data_type.toLowerCase())
      const isDate = ['date', 'datetime', 'timestamp', 'year'].includes(row.data_type.toLowerCase())
      const isText = ['varchar', 'text', 'char', 'longtext', 'mediumtext', 'tinytext'].includes(
        row.data_type.toLowerCase(),
      )

      return {
        name: row.column_name,
        type: row.data_type,
        comment: row.column_comment || '',
        nullable: row.is_nullable === 'YES',
        defaultValue: row.column_default,
        maxLength: row.max_length,
        isNumeric,
        isDate,
        isText,
        canBeGrouped:
          isText ||
          isDate ||
          row.column_name.includes('code') ||
          row.column_name.includes('category'),
        canBeAggregated: isNumeric,
        suitableForFilter: true,
        suggestedChartTypes: getSuggestedChartTypes(
          row.column_name,
          row.data_type,
          row.column_comment,
        ),
      }
    })
  } catch (error) {
    console.error('Error analyzing table structure:', error)
    return []
  } finally {
    if (connection) {
      await connection.end()
    }
  }
}

// Helper function to detect chart type from user query
function detectChartTypeFromQuery(userQuery: string): string | null {
  const query = userQuery.toLowerCase()
  const chartPatterns = {
    bar: ['bar chart', 'กราฟแท่ง', 'แผนภูมิแท่ง', 'แท่ง', 'เปรียบเทียบ'],
    column: ['column chart', 'กราฟคอลัมน์', 'แผนภูมิคอลัมน์', 'คอลัมน์'],
    line: [
      'line chart',
      'กราฟเส้น',
      'แผนภูมิเส้น',
      'เส้น',
      'การเปลี่ยนแปลง',
      'ตลอดเวลา',
      'ตามเวลา',
    ],
    pie: ['pie chart', 'กราฟวงกลม', 'แผนภูมิวงกลม', 'สัดส่วน', 'เปอร์เซ็นต์', 'pie'],
    donut: ['donut chart', 'กราฟโดนัท', 'แผนภูมิโดนัท', 'donut'],
    area: ['area chart', 'กราฟพื้นที่', 'แผนภูมิพื้นที่', 'สะสม'],
    scatter: ['scatter plot', 'scatter chart', 'กราฟกระจาย', 'จุดกระจาย', 'ความสัมพันธ์'],
    histogram: ['histogram', 'กราฟแจกแจง', 'การกระจาย', 'ฮิสโตแกรม'],
  }

  for (const [chartType, patterns] of Object.entries(chartPatterns)) {
    for (const pattern of patterns) {
      if (query.includes(pattern)) {
        return chartType
      }
    }
  }

  return null
}

// Helper function to suggest chart types based on column properties
function getSuggestedChartTypes(columnName: string, dataType: string, comment: string): string[] {
  const suggestions: string[] = []
  const name = columnName.toLowerCase()
  const type = dataType.toLowerCase()
  const desc = (comment || '').toLowerCase()

  // Time-based columns
  if (
    name.includes('year') ||
    name.includes('date') ||
    name.includes('time') ||
    type.includes('date')
  ) {
    suggestions.push('line', 'area')
  }

  // Categorical columns
  if (
    name.includes('country') ||
    name.includes('category') ||
    name.includes('type') ||
    name.includes('code')
  ) {
    suggestions.push('bar', 'column', 'pie', 'donut')
  }

  // Numeric columns
  if (['int', 'bigint', 'decimal', 'float', 'double'].includes(type)) {
    suggestions.push('histogram', 'scatter')
  }

  // Text columns with limited values
  if (
    type.includes('varchar') &&
    comment &&
    (desc.includes('enum') || desc.includes('choice') || desc.includes('type'))
  ) {
    suggestions.push('pie', 'donut', 'bar')
  }

  return suggestions.length > 0 ? suggestions : ['bar', 'column']
}

async function getAvailableColumns(tableName: string) {
  // ใช้ dynamic table analysis
  const dynamicColumns = await analyzeTableStructure(tableName)

  if (dynamicColumns.length > 0) {
    return dynamicColumns
  }

  // Dynamic fallback based on common column patterns
  console.warn(`Using dynamic fallback for table: ${tableName}`)
  return [
    {
      name: 'id',
      type: 'int',
      comment: 'Primary key identifier',
      isNumeric: true,
      isDate: false,
      isText: false,
      canBeGrouped: false,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['scatter'],
    },
    {
      name: 'name',
      type: 'varchar',
      comment: 'Name field',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['bar', 'column', 'pie'],
    },
    {
      name: 'category',
      type: 'varchar',
      comment: 'Category field',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['pie', 'donut', 'bar'],
    },
    {
      name: 'value',
      type: 'int',
      comment: 'Numeric value field',
      isNumeric: true,
      isDate: false,
      isText: false,
      canBeGrouped: false,
      canBeAggregated: true,
      suitableForFilter: true,
      suggestedChartTypes: ['histogram', 'scatter'],
    },
    {
      name: 'created_at',
      type: 'datetime',
      comment: 'Creation timestamp',
      isNumeric: false,
      isDate: true,
      isText: false,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['line', 'area'],
    },
  ]
}

const app = new Hono()

// เพิ่ม CORS middleware
app.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Accept'],
  }),
)

// API สำหรับ Server-Sent Events
app.post('/api/query-stream', async (c: any) => {
  const body = await c.req.json()
  const userQuery = z.string().parse(body.query)

  return streamSSE(c, async (stream: any) => {
    try {
      // ส่งข้อความเริ่มต้น
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: `รับคำถาม: ${userQuery}`,
          progress: 20,
        }),
        event: 'update',
      })

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังประมวลผลคำถาม...',
          progress: 50,
        }),
        event: 'update',
      })

      // โหลด tables และ columns แบบ dynamic จาก database
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังตรวจสอบ tables ที่มีอยู่ในฐานข้อมูล...',
          progress: 55,
        }),
        event: 'update',
      })

      const availableTables = await getAvailableTables()
      const bestTable = await detectBestTable(userQuery, availableTables)
      const tableName = bestTable.name

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: `เลือกใช้ตาราง: ${tableName} (${bestTable.comment})`,
          progress: 58,
        }),
        event: 'update',
      })

      const availableColumns = await getAvailableColumns(tableName)

      // ปรับปรุง prompt ให้ชัดเจนขึ้น
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังปรับปรุงคำถามให้ชัดเจนขึ้น...',
          progress: 59,
        }),
        event: 'update',
      })

      const promptImprovement = await improveUserPrompt(
        userQuery,
        availableColumns,
        availableTables,
        tableName,
      )

      const finalUserQuery = promptImprovement.improvedPrompt

      if (promptImprovement.wasImproved) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: `ปรับปรุงคำถาม: "${finalUserQuery.substring(0, 100)}${
              finalUserQuery.length > 100 ? '...' : ''
            }"`,
            progress: 60,
          }),
          event: 'update',
        })
      } else {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: 'คำถามชัดเจนแล้ว ไม่ต้องปรับปรุง',
            progress: 60,
          }),
          event: 'update',
        })
      }

      const databaseStatus =
        availableColumns.length > 0 && availableColumns[0].comment !== 'ไม่มีคำอธิบาย'
          ? 'เชื่อมต่อฐานข้อมูลสำเร็จ'
          : 'ใช้ข้อมูล fallback (ไม่สามารถเชื่อมต่อ DB)'

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: `${databaseStatus} - ตาราง: ${tableName}, columns: ${availableColumns.length}`,
          progress: 60,
        }),
        event: 'update',
      })

      // สร้าง dynamic columns description สำหรับ AI
      const columnsDescription = availableColumns
        .map((col) => {
          const chartTypes = col.suggestedChartTypes
            ? ` [Suggested charts: ${col.suggestedChartTypes.join(', ')}]`
            : ''
          const capabilities = []
          if (col.canBeGrouped) capabilities.push('groupable')
          if (col.canBeAggregated) capabilities.push('aggregatable')
          if (col.suitableForFilter) capabilities.push('filterable')

          return `- ${col.name} (${col.type}): ${
            col.comment || 'ไม่มีคำอธิบาย'
          } [${capabilities.join(', ')}]${chartTypes}`
        })
        .join('\n      ')

      // สร้าง smart prompt ที่ปรับตาม column types
      const smartColumnHints = availableColumns
        .filter((col) => col.canBeGrouped)
        .map((col) => `${col.name} (${col.type})`)
        .join(', ')

      const timeColumns = availableColumns
        .filter((col) => col.isDate || col.name.includes('year'))
        .map((col) => col.name)
        .join(', ')

      const categoryColumns = availableColumns
        .filter((col) => col.canBeGrouped && !col.isDate)
        .map((col) => col.name)
        .join(', ')

      // ตรวจสอบว่าผู้ใช้ระบุประเภท chart มาแล้วหรือไม่ (ใช้ query ที่ปรับปรุงแล้ว)
      const detectedChartType = detectChartTypeFromQuery(finalUserQuery)
      let columnAnalysis

      if (detectedChartType) {
        // ถ้าผู้ใช้ระบุ chart type มาแล้ว ข้าม AI analysis
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: `ตรวจพบประเภทกราฟ: ${detectedChartType} - ข้าม AI analysis`,
            progress: 70,
          }),
          event: 'update',
        })

        // สร้าง columnAnalysis แบบ simplified
        const relevantColumns = availableColumns.filter((col) => col.canBeGrouped).slice(0, 2)
        const primaryColumn = relevantColumns.length > 0 ? relevantColumns[0].name : 'country'

        columnAnalysis = {
          required_columns: relevantColumns.map((col) => col.name),
          chart_type: detectedChartType,
          alternative_charts: availableColumns
            .filter((col) => col.suggestedChartTypes.includes(detectedChartType))
            .flatMap((col) => col.suggestedChartTypes)
            .filter((type) => type !== detectedChartType)
            .slice(0, 2),
          analysis: `ใช้ประเภทกราฟที่ผู้ใช้ระบุ: ${detectedChartType}`,
          chart_reasoning: `ผู้ใช้ระบุประเภทกราฟ ${detectedChartType} ในคำถาม จึงข้าม AI analysis`,
          data_aggregation: 'count',
          x_axis: primaryColumn,
          y_axis: 'count',
          suggested_filters: [],
          column_reasoning: `เลือก columns ที่ groupable ได้สำหรับ ${detectedChartType} chart`,
        }

        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: `ใช้ ${detectedChartType} chart กับ columns ${columnAnalysis.required_columns.join(
              ', ',
            )}`,
            progress: 75,
          }),
          event: 'update',
        })
      } else {
        // วิเคราะห์ด้วย AI เหมือนเดิม (ใช้ query ที่ปรับปรุงแล้ว)
        const columnAnalysisPrompt = `
      วิเคราะห์คำถามต่อไปนี้และระบุว่าต้องใช้ column ไหนจากข้อมูลและเลือก chart type ที่เหมาะสมที่สุด:
      
      คำถามต้นฉบับ: "${userQuery}"
      คำถามที่ปรับปรุงแล้ว: "${finalUserQuery}"
      
      การปรับปรุงที่ทำ: ${promptImprovement.improvementsMade.join(', ')}
      Chart type ที่แนะนำ: ${promptImprovement.suggestedChartType || 'ไม่มี'}
      จุดเน้นข้อมูล: ${promptImprovement.dataFocus}
      
      Columns ที่มีในข้อมูล (พร้อม capabilities):
      ${columnsDescription}
      
      Column Categories:
      - Time-based columns: ${timeColumns || 'ไม่มี'}
      - Category columns: ${categoryColumns || 'ไม่มี'}
      - Groupable columns: ${smartColumnHints || 'ไม่มี'}
      
      ประเภท Chart ที่สามารถใช้ได้:
      1. bar - เหมาะสำหรับเปรียบเทียบค่าต่างๆ (เช่น จำนวนเหรียญของแต่ละประเทศ)
      2. line - เหมาะสำหรับแสดงการเปลี่ยนแปลงตามเวลา (เช่น เหรียญตลอดหลายปี)  
      3. pie - เหมาะสำหรับแสดงสัดส่วน (เช่น สัดส่วนเหรียญทอง เงิน ทองแดง)
      4. scatter - เหมาะสำหรับแสดงความสัมพันธ์ระหว่าง 2 ตัวแปร
      5. histogram - เหมาะสำหรับแสดงการกระจายของข้อมูล
      6. area - เหมาะสำหรับแสดงการเปลี่ยนแปลงตามเวลาแบบสะสม
      7. donut - เหมาะสำหรับแสดงสัดส่วนแบบมีพื้นที่กลาง
      8. column - เหมาะสำหรับเปรียบเทียบค่าต่างๆ แนวตั้ง
      
      การวิเคราะห์แบบ Dynamic:
      - ใช้ column capabilities เพื่อเลือก columns ที่เหมาะสม
      - พิจารณา suggested chart types ของแต่ละ column
      - เลือก aggregation method ที่เหมาะสมกับ data type
      - สร้าง meaningful combinations ระหว่าง columns
      
      วิเคราะห์และตอบกลับเป็น JSON object เท่านั้น:
      {
        "required_columns": ["column1", "column2"],
        "chart_type": "ประเภทกราฟที่เหมาะสมที่สุด",
        "alternative_charts": ["chart_type2", "chart_type3"],
        "analysis": "คำอธิบายว่าทำไมเลือก columns และ chart type นี้",
        "chart_reasoning": "เหตุผลที่เลือก chart type นี้และทำไมถึงเหมาะสมกับข้อมูล",
        "data_aggregation": "วิธีการรวมข้อมูล เช่น count, sum, average, group by",
        "x_axis": "ข้อมูลที่ควรแสดงในแกน X",
        "y_axis": "ข้อมูลที่ควรแสดงในแกน Y",
        "suggested_filters": ["filter suggestions based on query analysis"],
        "column_reasoning": "เหตุผลในการเลือก columns เฉพาะนี้จาก capabilities"
      }
      `

        // สร้าง AI model สำหรับวิเคราะห์
        const analysisModel = new ChatGoogleGenerativeAI({
          model: 'gemini-2.5-flash',
          apiKey: process.env.GEMINI_API_KEY,
          temperature: 0.1,
        })

        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: 'กำลังวิเคราะห์คำถามด้วย AI...',
            progress: 65,
          }),
          event: 'update',
        })

        const analysisResult = await analysisModel.invoke(columnAnalysisPrompt)

        try {
          // แปลง content เป็น string และหา JSON
          const contentString =
            typeof analysisResult.content === 'string'
              ? analysisResult.content
              : JSON.stringify(analysisResult.content)

          const jsonMatch = contentString.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            columnAnalysis = JSON.parse(jsonMatch[0])
          } else {
            throw new Error('ไม่พบ JSON ในการตอบ')
          }
        } catch (parseError) {
          console.error('Error parsing AI response:', parseError)
          // ใช้ค่า default หากไม่สามารถ parse ได้ - เลือกจาก column capabilities
          const defaultGroupableColumns = availableColumns
            .filter((col) => col.canBeGrouped)
            .slice(0, 2)
            .map((col) => col.name)
          const defaultXAxis =
            availableColumns.filter((col) => col.canBeGrouped)[0]?.name || 'country'

          columnAnalysis = {
            required_columns:
              defaultGroupableColumns.length > 0 ? defaultGroupableColumns : ['country', 'medal'],
            chart_type: 'bar',
            alternative_charts: ['column', 'pie'],
            analysis: 'ไม่สามารถวิเคราะห์ได้ ใช้ค่าเริ่มต้นจาก column capabilities',
            chart_reasoning:
              'ใช้กราฟแท่งเปรียบเทียบข้อมูลพื้นฐาน โดยเลือก columns ที่ groupable ได้',
            data_aggregation: 'count',
            x_axis: defaultXAxis,
            y_axis: 'count',
            suggested_filters: [],
            column_reasoning: 'เลือกจาก columns ที่มี canBeGrouped = true',
          }
        }

        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: `ผลการวิเคราะห์: ใช้ ${
              columnAnalysis.chart_type
            } chart กับ columns ${columnAnalysis.required_columns.join(', ')}`,
            progress: 75,
          }),
          event: 'update',
        })
      }

      // ดึงข้อมูลตัวอย่างสำหรับ AI เรียนรู้
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังดึงข้อมูลตัวอย่างสำหรับ AI เรียนรู้...',
          progress: 76,
        }),
        event: 'update',
      })

      const sampleData = await getSampleData(tableName, availableColumns, 10)

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: `ได้ข้อมูลตัวอย่าง ${sampleData.totalSampleCount} รายการ สำหรับ AI วิเคราะห์`,
          progress: 78,
        }),
        event: 'update',
      })

      // สร้าง SQL query
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังให้ AI สร้าง SQL query พร้อมตัวอย่างข้อมูล...',
          progress: 80,
        }),
        event: 'update',
      })

      const result = await generateSQLQueryWithAI(
        columnAnalysis,
        finalUserQuery, // ใช้ query ที่ปรับปรุงแล้ว
        availableColumns,
        sampleData,
        tableName, // dynamic table name based on auto-detection
      )

      const {
        sqlQuery,
        explanation,
        queryReasoning,
        columnsUsed,
        filtersApplied,
        chartSuitability,
        sampleDataInsights,
      } = result

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: `สร้าง SQL สำเร็จ: ${explanation}`,
          progress: 83,
        }),
        event: 'update',
      })

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลัง execute query ในฐานข้อมูล...',
          progress: 85,
        }),
        event: 'update',
      })

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลัง execute query พร้อมตรวจสอบผลลัพธ์ด้วย AI...',
          progress: 85,
        }),
        event: 'update',
      })

      // Execute query with AI verification and retry logic
      const queryExecutionResult = await executeQueryWithRetry(
        finalUserQuery, // ใช้ query ที่ปรับปรุงแล้ว
        columnAnalysis,
        availableColumns,
        sampleData,
        tableName,
        2, // max 2 retries
      )

      let queryResult = []
      let executionError = null
      let verificationInfo = null

      if (queryExecutionResult && queryExecutionResult.success) {
        queryResult = queryExecutionResult.queryResults
        verificationInfo = queryExecutionResult.verification

        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: `Query สำเร็จ! พบข้อมูล ${queryResult.length} รายการ (ความเชื่อมั่น: ${verificationInfo.confidenceScore}%)`,
            progress: 90,
          }),
          event: 'update',
        })

        // Show retry info if applicable
        if (queryExecutionResult.attempt > 1) {
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'status',
              message: `ใช้ความพยายามครั้งที่ ${queryExecutionResult.attempt}/${queryExecutionResult.maxRetries} จึงได้ผลลัพธ์ที่เหมาะสม`,
              progress: 92,
            }),
            event: 'update',
          })
        }
      } else {
        // Handle error case
        const errorResult = queryExecutionResult as any // Type assertion for error case
        executionError = errorResult?.error || new Error('Unknown execution error')
        verificationInfo = errorResult?.verification

        console.error('Query execution failed after retries:', executionError)

        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: `Query ไม่สำเร็จหลังจากลองแล้ว ${
              errorResult?.attempt || 0
            } ครั้ง - ใช้ข้อมูลจำลองแทน`,
            progress: 90,
          }),
          event: 'update',
        })

        // ใช้ข้อมูลจำลองหาก query ไม่สำเร็จ - format ให้เหมาะกับการใช้งาน
        queryResult = [
          { label: 'USA', count: 300 },
          { label: 'China', count: 250 },
          { label: 'Japan', count: 150 },
          { label: 'Great Britain', count: 120 },
          { label: 'Germany', count: 100 },
        ]
      }

      // จำลองการประมวลผล
      await new Promise((resolve) => setTimeout(resolve, 500))

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังสร้างผลลัพธ์...',
          progress: 95,
        }),
        event: 'update',
      })

      // สร้างผลลัพธ์จากข้อมูลจริง พร้อม format สำหรับ shadcn charts
      const chartData = parseQueryResultToChartData(queryResult, columnAnalysis)

      // เพิ่ม debug logging เพื่อช่วยแก้ไขปัญหา
      console.log('Query Result Sample:', queryResult.slice(0, 3))
      console.log('Chart Data Sample:', chartData.slice(0, 3))
      console.log('Total Data Points:', chartData.length)

      // Format data สำหรับ shadcn charts
      // Get SQL info from result (either from retry or original)
      const sqlInfo = queryExecutionResult?.sqlData || result
      const actualSqlQuery = sqlInfo.sqlQuery
      const actualExplanation = sqlInfo.explanation
      const actualQueryReasoning = (sqlInfo as any).queryReasoning || queryReasoning || ''
      const actualColumnsUsed = (sqlInfo as any).columnsUsed || columnsUsed || []
      const actualFiltersApplied = (sqlInfo as any).filtersApplied || filtersApplied || []
      const actualChartSuitability = (sqlInfo as any).chartSuitability || chartSuitability || ''

      const shadcnChartData = generateShadcnChartResponse(
        columnAnalysis.chart_type as ChartType,
        chartData,
        `ผลลัพธ์สำหรับ: ${promptImprovement.wasImproved ? finalUserQuery : userQuery}`,
        {
          columns_used:
            actualColumnsUsed.length > 0 ? actualColumnsUsed : columnAnalysis.required_columns,
          aggregation_method: columnAnalysis.data_aggregation || 'count',
          filters_applied: actualFiltersApplied.length > 0 ? actualFiltersApplied : [],
          total_records: chartData.length,
          data_range: executionError ? 'mock data (query failed)' : 'real data from database',
          analysis: columnAnalysis.analysis,
          chart_reasoning: columnAnalysis.chart_reasoning,
          alternative_charts: columnAnalysis.alternative_charts || [],
          axis_info: {
            x_axis: columnAnalysis.x_axis,
            y_axis: columnAnalysis.y_axis,
          },
          sql_query: actualSqlQuery,
          sql_explanation: actualExplanation,
          sql_reasoning: actualQueryReasoning,
          chart_suitability: actualChartSuitability,
          query_execution: {
            success: !executionError,
            error: executionError
              ? executionError instanceof Error
                ? executionError.message
                : 'Unknown error'
              : null,
            rows_returned: queryResult.length,
          },
          // Add AI verification info
          ai_verification: verificationInfo
            ? {
                is_valid: verificationInfo.isValid,
                confidence_score: verificationInfo.confidenceScore,
                issues_found: verificationInfo.issuesFound,
                suggestions: verificationInfo.suggestions,
                data_quality: verificationInfo.dataQuality,
                reasoning: verificationInfo.reasoning,
              }
            : null,
          retry_info: queryExecutionResult
            ? {
                attempts_made: queryExecutionResult.attempt,
                max_retries: queryExecutionResult.maxRetries,
                final_success: queryExecutionResult.success,
              }
            : null,
          // Add prompt improvement info
          prompt_improvement: {
            original_prompt: userQuery,
            improved_prompt: finalUserQuery,
            was_improved: promptImprovement.wasImproved,
            improvements_made: promptImprovement.improvementsMade,
            suggested_chart_type: promptImprovement.suggestedChartType,
            key_insights: promptImprovement.keyInsights,
            data_focus: promptImprovement.dataFocus,
            filter_suggestions: promptImprovement.filterSuggestions,
            reasoning: promptImprovement.reasoning,
          },
          // Add debug info to help troubleshoot data parsing issues
          debug_info: {
            raw_query_sample: queryResult.slice(0, 3),
            processed_chart_sample: chartData.slice(0, 3),
            data_transformation: {
              total_raw_records: queryResult.length,
              total_chart_points: chartData.length,
              value_fields_detected:
                queryResult.length > 0
                  ? Object.keys(queryResult[0]).filter((key) => {
                      const lowKey = key.toLowerCase()
                      return (
                        lowKey.includes('count') ||
                        lowKey.includes('value') ||
                        lowKey.includes('total') ||
                        lowKey.includes('sum') ||
                        lowKey.includes('amount') ||
                        lowKey.includes('number')
                      )
                    })
                  : [],
              all_fields: queryResult.length > 0 ? Object.keys(queryResult[0]) : [],
            },
          },
          available_columns: availableColumns.map((col) => ({
            name: col.name,
            type: col.type,
            comment: col.comment,
          })),
          database_info: {
            connected: true,
            total_columns: availableColumns.length,
          },
        },
      )
      console.log('sqlQuery:', sqlQuery)
      const realResult = {
        ...shadcnChartData,
        // เก็บ legacy format สำหรับ backward compatibility
        legacy_data: chartData,
        legacy_metadata: {
          columns_used: columnsUsed.length > 0 ? columnsUsed : columnAnalysis.required_columns,
          aggregation_method: columnAnalysis.data_aggregation || 'count',
          filters_applied: filtersApplied.length > 0 ? filtersApplied : [],
          total_records: chartData.length,
          data_range: executionError ? 'mock data (query failed)' : 'real data from database',
          analysis: columnAnalysis.analysis,
          chart_reasoning: columnAnalysis.chart_reasoning,
          alternative_charts: columnAnalysis.alternative_charts || [],
          axis_info: {
            x_axis: columnAnalysis.x_axis,
            y_axis: columnAnalysis.y_axis,
          },
          sql_query: sqlQuery,
          sql_explanation: explanation,
          sql_reasoning: queryReasoning,
          chart_suitability: chartSuitability,
          query_execution: {
            success: !executionError,
            error: executionError
              ? executionError instanceof Error
                ? executionError.message
                : 'Unknown error'
              : null,
            rows_returned: queryResult.length,
          },
          available_columns: availableColumns.map((col) => ({
            name: col.name,
            type: col.type,
            comment: col.comment,
          })),
          database_info: {
            connected: true,
            total_columns: availableColumns.length,
          },
        },
      }

      // ส่งผลลัพธ์
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'result',
          message: 'การประมวลผลเสร็จสิ้น',
          progress: 100,
          result: realResult,
          column_analysis: columnAnalysis,
        }),
        event: 'complete',
      })

      // ปิด connection
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'done',
          message: 'เสร็จสิ้น',
        }),
        event: 'done',
      })
    } catch (error) {
      console.error('Error in streaming:', error)
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'error',
          message: 'เกิดข้อผิดพลาดในการประมวลผล',
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
        event: 'error',
      })
    }
  })
})

// Simple SSE test endpoint
app.get('/api/test-stream', (c: any) => {
  return streamSSE(c, async (stream: any) => {
    for (let i = 1; i <= 10; i++) {
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'test',
          message: `ข้อความทดสอบ ${i}/10`,
          progress: i * 10,
        }),
        event: 'update',
      })

      // รอ 1 วินาที
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    await stream.writeSSE({
      data: JSON.stringify({
        type: 'done',
        message: 'การทดสอบเสร็จสิ้น',
      }),
      event: 'done',
    })
  })
})

app.post('/api/query', async (c: any) => {
  const body = await c.req.json()
  const userQuery = z.string().parse(body.query)

  const model = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.3,
  })

  const loader = new CSVLoader('all-olympic-medalists-1896-2024.csv')
  const docs = await loader.load()

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 5000,
    chunkOverlap: 200,
  })
  const splitDocs = await splitter.splitDocuments(docs)

  const vectorStore = await MemoryVectorStore.fromDocuments(
    splitDocs,
    new GoogleGenerativeAIEmbeddings({
      modelName: 'models/embedding-001',
      apiKey: process.env.GEMINI_API_KEY,
    }),
  )
  const retriever = vectorStore.asRetriever({
    k: 10, // เพิ่มจำนวน chunks ที่จะ retrieve
  })

  const chain = RetrievalQAChain.fromLLM(model, retriever)
  const result = await chain.call({
    query: `
    You are a data analyst assistant. Analyze the user's query and provide structured JSON data for creating graphs/charts.

    DATASET INFORMATION:
    - Total records: ~20,249 Olympic medal records from 1896-2024
    - Available columns: season, year, medal, country_code, country, athletes, games, sport, event_gender, event_name
    - Medal types: Gold, Silver, Bronze
    - Time range: 1896-2024 Olympics
    - Countries: Multiple countries with country codes

    USER QUERY: "${userQuery}"

    IMPORTANT: You have access to a LARGE dataset with thousands of records. Don't limit yourself to just a few samples.
    Analyze ALL relevant data to provide comprehensive results.

    INSTRUCTIONS:
    1. Analyze what type of visualization the user wants (bar chart, line chart, pie chart, etc.)
    2. Identify which columns are needed from the dataset
    3. Determine appropriate aggregations (count, sum, group by, etc.)
    4. Structure the output as JSON that's ready for chart libraries
    5. Include as much relevant data as possible, not just 2-3 samples

    EXPECTED JSON FORMAT:
    {
      "chart_type": "bar|line|pie|scatter|histogram",
      "title": "Chart title in Thai",
      "data": [
        {
          "label": "category name",
          "value": number,
          "additional_info": {}
        }
      ],
      "metadata": {
        "columns_used": ["column1", "column2"],
        "aggregation_method": "count|sum|average",
        "filters_applied": [],
        "total_records": number,
        "data_range": "description of data coverage"
      }
    }

    REQUIREMENTS:
    - Provide actual data analysis from the full dataset, not just sample data
    - Include Thai language labels where appropriate
    - Make sure JSON is valid and ready for chart libraries
    - Include metadata for transparency
    - Suggest the most appropriate chart type for the query
    - Include comprehensive data, not just 2-3 entries

    Please analyze the FULL dataset and provide the structured JSON response.
    `,
  })

  return c.json({
    result,
  })
})

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`)
  },
)
