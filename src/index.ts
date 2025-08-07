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

// Function to generate SQL query using AI with dynamic rules
async function generateSQLQueryWithAI(
  columnAnalysis: any,
  userQuery: string,
  availableColumns: any[],
  tableName: string = 'olympic_medalists',
) {
  const analysisModel = new ChatGoogleGenerativeAI({
    model: 'gemini-1.5-flash',
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

  รูปแบบ Query สำหรับ ${columnAnalysis.chart_type} chart:
  ${selectedPattern}

  กฎการสร้าง SQL (Dynamic Rules):
  
  ## พื้นฐานการสร้าง Query:
  1. ใช้เฉพาะ columns ที่มีในตารางที่ระบุ
  2. วิเคราะห์ประเภทข้อมูลของแต่ละ column เพื่อเลือกการประมวลผลที่เหมาะสม
  3. ใช้ alias ที่เหมาะสมสำหรับ SELECT clause
  
  ## รูปแบบ Query ตาม Chart Type:
  - **Categorical Charts (bar/column/pie)**: SELECT [category_column], COUNT(*) AS count FROM [table] GROUP BY [category_column]
  - **Time Series Charts (line/area)**: SELECT [time_column], [aggregation] FROM [table] GROUP BY [time_column] ORDER BY [time_column]
  - **Distribution Charts (histogram)**: SELECT [numeric_column], COUNT(*) AS frequency FROM [table] GROUP BY [numeric_column]
  - **Comparison Charts (scatter)**: SELECT [x_column], [y_column] FROM [table]
  
  ## Dynamic WHERE Clause Construction:
  - วิเคราะห์คำถามเพื่อหา filter conditions
  - ใช้ column comments และ sample data เพื่อเข้าใจรูปแบบข้อมูล
  - สร้าง condition ที่เหมาะสมกับ data type (string, number, date)
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
  
  ## Error Handling:
  - ตรวจสอบ column existence ก่อนสร้าง query
  - ใช้ fallback query หาก parsing ล้มเหลว
  - รองรับ multiple table joins หากจำเป็น

  ตัวอย่างการสร้าง WHERE clause แบบ dynamic:
  - ถ้าหาคำว่า "ไทย", "Thailand", "THA" → ใช้ columns ที่เกี่ยวกับประเทศ
  - ถ้าหาตัวเลขปี → ใช้ columns ที่เป็น date/year
  - ถ้าหาชื่อกีฬา → ใช้ columns ที่เกี่ยวกับ sport/event
  - ถ้าหาประเภทเหรียญ → ใช้ columns ที่เกี่ยวกับ medal

  วิเคราะห์คำถามอย่างละเอียดและสร้าง SQL ที่:
  1. ใช้ columns ที่เหมาะสมจาก analysis
  2. สร้าง WHERE clause ที่ตรงกับความต้องการ
  3. เลือก aggregation ที่เหมาะสมกับข้อมูล
  4. กำหนด ORDER BY และ LIMIT ที่เหมาะสม

  ตอบกลับเป็น JSON object เท่านั้น:
  {
    "sql_query": "SELECT ... FROM ${tableName} WHERE ... GROUP BY ... ORDER BY ... LIMIT ...",
    "explanation": "คำอธิบายละเอียดว่าทำไมสร้าง query นี้ รวมถึงการเลือก columns, WHERE conditions, และ aggregation strategy",
    "query_reasoning": "เหตุผลเชิงเทคนิคของการออกแบบ query นี้",
    "columns_used": ["column1", "column2"],
    "filters_applied": ["filter description"],
    "chart_suitability": "อธิบายว่า query นี้เหมาะสมกับ chart type อย่างไร"
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
  }
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

async function getAvailableColumns(tableName: string = 'olympic_medalists') {
  // ใช้ dynamic table analysis
  const dynamicColumns = await analyzeTableStructure(tableName)

  if (dynamicColumns.length > 0) {
    return dynamicColumns
  }

  // Fallback เมื่อไม่สามารถเชื่อมต่อ database
  console.warn('Using fallback column definitions')
  return [
    {
      name: 'season',
      type: 'varchar',
      comment: 'ฤดูกาล (Summer/Winter)',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['pie', 'donut', 'bar'],
    },
    {
      name: 'year',
      type: 'int',
      comment: 'ปี',
      isNumeric: true,
      isDate: false,
      isText: false,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['line', 'area', 'bar'],
    },
    {
      name: 'medal',
      type: 'varchar',
      comment: 'ประเภทเหรียญ (Gold/Silver/Bronze)',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['pie', 'donut', 'bar'],
    },
    {
      name: 'country_code',
      type: 'varchar',
      comment: 'รหัสประเทศ (THA, USA, etc.)',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['bar', 'column', 'pie'],
    },
    {
      name: 'country',
      type: 'varchar',
      comment: 'ชื่อประเทศ',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['bar', 'column', 'pie'],
    },
    {
      name: 'athletes',
      type: 'varchar',
      comment: 'ชื่อนักกีฬา',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: false,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['bar'],
    },
    {
      name: 'games',
      type: 'varchar',
      comment: 'การแข่งขัน (2024 Paris, 2020 Tokyo, etc.)',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['bar', 'column'],
    },
    {
      name: 'sport',
      type: 'varchar',
      comment: 'ประเภทกีฬา (Swimming, Athletics, etc.)',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['bar', 'column', 'pie'],
    },
    {
      name: 'event_gender',
      type: 'varchar',
      comment: 'เพศ (Men, Women, Mixed)',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['pie', 'donut', 'bar'],
    },
    {
      name: 'event_name',
      type: 'varchar',
      comment: 'ชื่อรายการแข่งขัน',
      isNumeric: false,
      isDate: false,
      isText: true,
      canBeGrouped: true,
      canBeAggregated: false,
      suitableForFilter: true,
      suggestedChartTypes: ['bar', 'column'],
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

app.get('/', (c: any) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>SSE Test</title>
        <meta charset="UTF-8">
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .container { max-width: 800px; margin: 0 auto; }
            textarea { width: 100%; height: 100px; margin: 10px 0; }
            button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; }
            button:disabled { background: #ccc; cursor: not-allowed; }
            .output { border: 1px solid #ccc; padding: 10px; margin: 10px 0; height: 300px; overflow-y: scroll; }
            .message { margin: 5px 0; padding: 5px; }
            .status { background: #e7f3ff; }
            .result { background: #e7ffe7; }
            .error { background: #ffe7e7; }
            .progress { width: 100%; height: 20px; margin: 10px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Server-Sent Events Test</h1>
            <textarea id="query" placeholder="ใส่คำถามของคุณที่นี่... เช่น:
- แสดงจำนวนเหรียญทองของประเทศไทย (bar chart)
- เปรียบเทียบเหรียญของประเทศต่างๆ ในปี 2024 (column chart)
- แสดงการเปลี่ยนแปลงเหรียญทองของ USA ตลอดเวลา (line chart)
- แสดงสัดส่วนเหรียญทอง เงิน ทองแดงของไทย (pie chart)
- แสดงการกระจายของอายุนักกีฬา (histogram)
- แสดงกีฬาที่ไทยได้เหรียญมากที่สุด (bar chart)">แสดงจำนวนเหรียญทองของประเทศไทย</textarea><br>
            <button id="sendBtn" onclick="sendQuery()">ส่งคำถาม (AI Analysis)</button>
            <button id="testBtn" onclick="testStream()">ทดสอบ SSE</button>
            <button id="columnsBtn" onclick="loadColumns()">ดู Columns</button>
            <button id="testDbBtn" onclick="testDatabase()">ทดสอบ DB</button>
            <button id="clearBtn" onclick="clearOutput()">ล้างผลลัพธ์</button>
            
            <progress id="progress" class="progress" value="0" max="100"></progress>
            <div id="output" class="output"></div>
        </div>

        <script>
            let eventSource = null;
            
            function sendQuery() {
                const query = document.getElementById('query').value;
                const output = document.getElementById('output');
                const sendBtn = document.getElementById('sendBtn');
                const progress = document.getElementById('progress');
                
                if (!query.trim()) {
                    alert('กรุณาใส่คำถาม');
                    return;
                }
                
                sendBtn.disabled = true;
                progress.value = 0;
                
                // ปิด connection เก่าถ้ามี
                if (eventSource) {
                    eventSource.close();
                }
                
                // ส่ง request ไปที่ API
                fetch('/api/query-stream', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ query: query })
                })
                .then(response => {
                    if (!response.ok) throw new Error('Network response was not ok');
                    
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    
                    function readStream() {
                        return reader.read().then(({ done, value }) => {
                            if (done) {
                                sendBtn.disabled = false;
                                return;
                            }
                            
                            const chunk = decoder.decode(value);
                            const lines = chunk.split('\\n');
                            
                            lines.forEach(line => {
                                if (line.startsWith('data: ')) {
                                    try {
                                        const data = JSON.parse(line.substring(6));
                                        handleSSEMessage(data);
                                    } catch (e) {
                                        console.error('Error parsing SSE data:', e);
                                    }
                                }
                            });
                            
                            return readStream();
                        });
                    }
                    
                    return readStream();
                })
                .catch(error => {
                    console.error('Error:', error);
                    addMessage('เกิดข้อผิดพลาด: ' + error.message, 'error');
                    sendBtn.disabled = false;
                });
            }
            
            function handleSSEMessage(data) {
                const output = document.getElementById('output');
                const progress = document.getElementById('progress');
                
                if (data.progress) {
                    progress.value = data.progress;
                }
                
                switch (data.type) {
                    case 'status':
                        addMessage(data.message, 'status');
                        break;
                    case 'result':
                        addMessage('✅ ' + data.message, 'result');
                        if (data.column_analysis) {
                            addMessage('📊 การวิเคราะห์: ' + data.column_analysis.analysis, 'result');
                            addMessage('🔍 Columns ที่ใช้: ' + data.column_analysis.required_columns.join(', '), 'result');
                            addMessage('📈 ประเภทกราฟหลัก: ' + data.column_analysis.chart_type, 'result');
                            if (data.column_analysis.alternative_charts && data.column_analysis.alternative_charts.length > 0) {
                                addMessage('📊 กราฟทางเลือก: ' + data.column_analysis.alternative_charts.join(', '), 'result');
                            }
                            if (data.column_analysis.chart_reasoning) {
                                addMessage('💡 เหตุผล: ' + data.column_analysis.chart_reasoning, 'result');
                            }
                            if (data.column_analysis.x_axis && data.column_analysis.y_axis) {
                                addMessage('📐 แกน X: ' + data.column_analysis.x_axis + ', แกน Y: ' + data.column_analysis.y_axis, 'result');
                            }
                        if (data.column_analysis.column_reasoning) {
                            addMessage('🔧 Column Reasoning: ' + data.column_analysis.column_reasoning, 'result');
                        }
                        if (data.column_analysis.suggested_filters && data.column_analysis.suggested_filters.length > 0) {
                            addMessage('🎯 Suggested Filters: ' + data.column_analysis.suggested_filters.join(', '), 'result');
                        }
                        }
                        if (data.result.metadata && data.result.metadata.database_info) {
                            addMessage('🗄️ Database: เชื่อมต่อสำเร็จ, มี ' + data.result.metadata.database_info.total_columns + ' columns', 'result');
                        }
                        if (data.result.metadata && data.result.metadata.sql_query) {
                            addMessage('📝 SQL Query: ' + data.result.metadata.sql_query.replace(/\s+/g, ' ').trim(), 'result');
                        }
                        if (data.result.metadata && data.result.metadata.sql_explanation) {
                            addMessage('💭 SQL Explanation: ' + data.result.metadata.sql_explanation, 'result');
                        }
                        if (data.result.metadata && data.result.metadata.sql_reasoning) {
                            addMessage('🔍 SQL Reasoning: ' + data.result.metadata.sql_reasoning, 'result');
                        }
                        if (data.result.metadata && data.result.metadata.columns_used) {
                            addMessage('📊 Columns Used: ' + data.result.metadata.columns_used.join(', '), 'result');
                        }
                        if (data.result.metadata && data.result.metadata.filters_applied && data.result.metadata.filters_applied.length > 0) {
                            addMessage('🔎 Filters Applied: ' + data.result.metadata.filters_applied.join(', '), 'result');
                        }
                        if (data.result.metadata && data.result.metadata.chart_suitability) {
                            addMessage('📈 Chart Suitability: ' + data.result.metadata.chart_suitability, 'result');
                        }
                        if (data.result.metadata && data.result.metadata.query_execution) {
                            const exec = data.result.metadata.query_execution;
                            if (exec.success) {
                                addMessage('✅ Query สำเร็จ: ได้ข้อมูล ' + exec.rows_returned + ' รายการ', 'result');
                            } else {
                                addMessage('❌ Query ไม่สำเร็จ: ' + exec.error, 'error');
                            }
                        }
                        addMessage('ผลลัพธ์: ' + JSON.stringify(data.result, null, 2), 'result');
                        break;
                    case 'error':
                        addMessage('❌ ' + data.message + ': ' + data.error, 'error');
                        break;
                    case 'done':
                        addMessage('🎉 เสร็จสิ้นแล้ว!', 'result');
                        document.getElementById('sendBtn').disabled = false;
                        break;
                }
                
                output.scrollTop = output.scrollHeight;
            }
            
            function addMessage(message, type) {
                const output = document.getElementById('output');
                const div = document.createElement('div');
                div.className = 'message ' + type;
                div.textContent = new Date().toLocaleTimeString() + ': ' + message;
                output.appendChild(div);
            }
            
            function clearOutput() {
                document.getElementById('output').innerHTML = '';
                document.getElementById('progress').value = 0;
            }
            
            function testStream() {
                const output = document.getElementById('output');
                const testBtn = document.getElementById('testBtn');
                const progress = document.getElementById('progress');
                
                testBtn.disabled = true;
                progress.value = 0;
                
                fetch('/api/test-stream')
                .then(response => {
                    if (!response.ok) throw new Error('Network response was not ok');
                    
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    
                    function readStream() {
                        return reader.read().then(({ done, value }) => {
                            if (done) {
                                testBtn.disabled = false;
                                return;
                            }
                            
                            const chunk = decoder.decode(value);
                            const lines = chunk.split('\\n');
                            
                            lines.forEach(line => {
                                if (line.startsWith('data: ')) {
                                    try {
                                        const data = JSON.parse(line.substring(6));
                                        handleSSEMessage(data);
                                    } catch (e) {
                                        console.error('Error parsing SSE data:', e);
                                    }
                                }
                            });
                            
                            return readStream();
                        });
                    }
                    
                    return readStream();
                })
                .catch(error => {
                    console.error('Error:', error);
                    addMessage('เกิดข้อผิดพลาด: ' + error.message, 'error');
                    testBtn.disabled = false;
                });
            }
            
            function loadColumns() {
                const columnsBtn = document.getElementById('columnsBtn');
                columnsBtn.disabled = true;
                
                fetch('/api/columns')
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        addMessage('📋 Columns ที่มีในฐานข้อมูล:', 'result');
                        data.columns.forEach((col, index) => {
                            addMessage((index + 1) + '. ' + col.name + ' (' + col.type + '): ' + (col.comment || 'ไม่มีคำอธิบาย'), 'result');
                        });
                        addMessage('รวม ' + data.total + ' columns', 'result');
                    } else {
                        addMessage('❌ ไม่สามารถโหลด columns ได้: ' + data.error, 'error');
                    }
                    columnsBtn.disabled = false;
                })
                .catch(error => {
                    console.error('Error:', error);
                    addMessage('เกิดข้อผิดพลาด: ' + error.message, 'error');
                    columnsBtn.disabled = false;
                });
            }
            
            function testDatabase() {
                const testDbBtn = document.getElementById('testDbBtn');
                testDbBtn.disabled = true;
                
                fetch('/api/test-db')
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        addMessage('✅ ' + data.message, 'result');
                        addMessage('🔧 Database: ' + data.config.host + ':' + data.config.port + '/' + data.config.database, 'result');
                    } else {
                        addMessage('❌ ' + data.message + ': ' + data.error, 'error');
                    }
                    testDbBtn.disabled = false;
                })
                .catch(error => {
                    console.error('Error:', error);
                    addMessage('เกิดข้อผิดพลาด: ' + error.message, 'error');
                    testDbBtn.disabled = false;
                });
            }
        </script>
    </body>
    </html>
  `)
})

// API สำหรับทดสอบ SQL query
app.post('/api/test-query', async (c: any) => {
  try {
    const body = await c.req.json()
    const { query } = body

    if (!query) {
      return c.json({ success: false, error: 'Query is required' }, 400)
    }

    const result = await executeQuery(query)

    return c.json({
      success: true,
      query: query,
      result: result,
      rows_count: result.length,
    })
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500,
    )
  }
})

// API สำหรับทดสอบการเชื่อมต่อฐานข้อมูล
app.get('/api/test-db', async (c: any) => {
  try {
    const connection = await mysql.createConnection(dbConfig)
    await connection.execute('SELECT 1 as test')
    await connection.end()

    return c.json({
      success: true,
      message: 'เชื่อมต่อฐานข้อมูลสำเร็จ',
      config: {
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        user: dbConfig.user,
      },
    })
  } catch (error) {
    return c.json(
      {
        success: false,
        message: 'ไม่สามารถเชื่อมต่อฐานข้อมูลได้',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500,
    )
  }
})

// API สำหรับดู columns ที่มีอยู่
app.get('/api/columns', async (c: any) => {
  try {
    const columns = await getAvailableColumns()
    return c.json({
      success: true,
      columns: columns,
      total: columns.length,
    })
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500,
    )
  }
})

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

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังโหลดข้อมูล columns จากฐานข้อมูล...',
          progress: 55,
        }),
        event: 'update',
      })

      // โหลด columns แบบ dynamic จาก database
      const tableName = 'olympic_medalists' // สามารถทำให้ dynamic ได้ในอนาคต
      const availableColumns = await getAvailableColumns(tableName)

      const databaseStatus =
        availableColumns.length > 0 && availableColumns[0].comment !== 'ไม่มีคำอธิบาย'
          ? 'เชื่อมต่อฐานข้อมูลสำเร็จ'
          : 'ใช้ข้อมูล fallback (ไม่สามารถเชื่อมต่อ DB)'

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: `${databaseStatus} - พบ ${availableColumns.length} columns`,
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

      // ตรวจสอบว่าผู้ใช้ระบุประเภท chart มาแล้วหรือไม่
      const detectedChartType = detectChartTypeFromQuery(userQuery)
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
        // วิเคราะห์ด้วย AI เหมือนเดิม
        const columnAnalysisPrompt = `
      วิเคราะห์คำถามต่อไปนี้และระบุว่าต้องใช้ column ไหนจากข้อมูลและเลือก chart type ที่เหมาะสมที่สุด:
      
      คำถาม: "${userQuery}"
      
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
          model: 'gemini-1.5-flash',
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

      // สร้าง SQL query
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังให้ AI สร้าง SQL query...',
          progress: 80,
        }),
        event: 'update',
      })

      const result = await generateSQLQueryWithAI(
        columnAnalysis,
        userQuery,
        availableColumns,
        'olympic_medalists', // table name - สามารถทำให้ dynamic ได้ในอนาคต
      )

      const {
        sqlQuery,
        explanation,
        queryReasoning,
        columnsUsed,
        filtersApplied,
        chartSuitability,
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

      // Execute query และรับข้อมูลจริง
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังดึงข้อมูลจากฐานข้อมูล...',
          progress: 85,
        }),
        event: 'update',
      })

      let queryResult = []
      let executionError = null

      try {
        queryResult = await executeQuery(sqlQuery)

        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: `Query สำเร็จ! พบข้อมูล ${queryResult.length} รายการ`,
            progress: 90,
          }),
          event: 'update',
        })
      } catch (error) {
        executionError = error
        console.error('Query execution failed:', error)

        await stream.writeSSE({
          data: JSON.stringify({
            type: 'status',
            message: 'Query ไม่สำเร็จ ใช้ข้อมูลจำลองแทน...',
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
      const chartData = queryResult.map((row) => {
        // แปลงข้อมูลให้เหมาะกับ chart format
        const keys = Object.keys(row)
        const labelKey = keys.find((key) => !['count', 'value', 'total'].includes(key)) || keys[0]
        const valueKey = keys.find((key) => ['count', 'value', 'total'].includes(key)) || keys[1]

        return {
          label: row[labelKey]?.toString() || 'Unknown',
          value: parseInt(row[valueKey]) || 0,
          additional_info: row,
        }
      })

      // Format data สำหรับ shadcn charts
      const shadcnChartData = generateShadcnChartResponse(
        columnAnalysis.chart_type as ChartType,
        chartData,
        `ผลลัพธ์สำหรับ: ${userQuery}`,
        {
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
      )

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
    model: 'gemini-2.5-pro',
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
