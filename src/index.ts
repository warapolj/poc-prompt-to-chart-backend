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

// Database configuration
const dbConfig = {
  host: 'localhost',
  port: 3306,
  user: 'poc_user',
  password: 'poc_password',
  database: 'poc_chart_db',
}

// Function to get available columns from database
async function getAvailableColumns() {
  let connection
  try {
    connection = await mysql.createConnection(dbConfig)

    const [rows] = await connection.execute(
      `
      SELECT 
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        COLUMN_COMMENT as column_comment
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'olympic_medalists'
      AND COLUMN_NAME NOT IN ('id', 'created_at')
      ORDER BY ORDINAL_POSITION
    `,
      [dbConfig.database],
    )

    return (rows as any[]).map((row) => ({
      name: row.column_name,
      type: row.data_type,
      comment: row.column_comment || '',
    }))
  } catch (error) {
    console.error('Error fetching columns:', error)
    // Fallback to hardcoded columns if database is not available
    return [
      { name: 'season', type: 'varchar', comment: 'ฤดูกาล (Summer/Winter)' },
      { name: 'year', type: 'int', comment: 'ปี' },
      { name: 'medal', type: 'varchar', comment: 'ประเภทเหรียญ (Gold/Silver/Bronze)' },
      { name: 'country_code', type: 'varchar', comment: 'รหัสประเทศ (THA, USA, etc.)' },
      { name: 'country', type: 'varchar', comment: 'ชื่อประเทศ' },
      { name: 'athletes', type: 'varchar', comment: 'ชื่อนักกีฬา' },
      { name: 'games', type: 'varchar', comment: 'การแข่งขัน (2024 Paris, 2020 Tokyo, etc.)' },
      { name: 'sport', type: 'varchar', comment: 'ประเภทกีฬา (Swimming, Athletics, etc.)' },
      { name: 'event_gender', type: 'varchar', comment: 'เพศ (Men, Women, Mixed)' },
      { name: 'event_name', type: 'varchar', comment: 'ชื่อรายการแข่งขัน' },
    ]
  } finally {
    if (connection) {
      await connection.end()
    }
  }
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
                            if (data.column_analysis.data_aggregation) {
                                addMessage('🧮 การรวมข้อมูล: ' + data.column_analysis.data_aggregation, 'result');
                            }
                        }
                        if (data.result.metadata && data.result.metadata.database_info) {
                            addMessage('🗄️ Database: เชื่อมต่อสำเร็จ, มี ' + data.result.metadata.database_info.total_columns + ' columns', 'result');
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
      const availableColumns = await getAvailableColumns()

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

      // สร้าง columns description สำหรับ AI
      const columnsDescription = availableColumns
        .map((col) => `- ${col.name} (${col.type}): ${col.comment || 'ไม่มีคำอธิบาย'}`)
        .join('\n      ')

      const columnAnalysisPrompt = `
      วิเคราะห์คำถามต่อไปนี้และระบุว่าต้องใช้ column ไหนจากข้อมูล Olympic และเลือก chart type ที่เหมาะสมที่สุด:
      
      คำถาม: "${userQuery}"
      
      Columns ที่มีในข้อมูล:
      ${columnsDescription}
      
      ประเภท Chart ที่สามารถใช้ได้:
      1. bar - เหมาะสำหรับเปรียบเทียบค่าต่างๆ (เช่น จำนวนเหรียญของแต่ละประเทศ)
      2. line - เหมาะสำหรับแสดงการเปลี่ยนแปลงตามเวลา (เช่น เหรียญตลอดหลายปี)  
      3. pie - เหมาะสำหรับแสดงสัดส่วน (เช่น สัดส่วนเหรียญทอง เงิน ทองแดง)
      4. scatter - เหมาะสำหรับแสดงความสัมพันธ์ระหว่าง 2 ตัวแปร
      5. histogram - เหมาะสำหรับแสดงการกระจายของข้อมูล
      6. area - เหมาะสำหรับแสดงการเปลี่ยนแปลงตามเวลาแบบสะสม
      7. donut - เหมาะสำหรับแสดงสัดส่วนแบบมีพื้นที่กลาง
      8. column - เหมาะสำหรับเปรียบเทียบค่าต่างๆ แนวตั้ง
      
      วิเคราะห์และตอบกลับเป็น JSON object เท่านั้น:
      {
        "required_columns": ["column1", "column2"],
        "chart_type": "ประเภทกราฟที่เหมาะสมที่สุด",
        "alternative_charts": ["chart_type2", "chart_type3"],
        "analysis": "คำอธิบายว่าทำไมเลือก columns และ chart type นี้",
        "chart_reasoning": "เหตุผลที่เลือก chart type นี้และทำไมถึงเหมาะสมกับข้อมูล",
        "data_aggregation": "วิธีการรวมข้อมูล เช่น count, sum, average, group by",
        "x_axis": "ข้อมูลที่ควรแสดงในแกน X",
        "y_axis": "ข้อมูลที่ควรแสดงในแกน Y"
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
      let columnAnalysis

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
        // ใช้ค่า default หากไม่สามารถ parse ได้
        columnAnalysis = {
          required_columns: ['country', 'medal'],
          chart_type: 'bar',
          alternative_charts: ['column', 'pie'],
          analysis: 'ไม่สามารถวิเคราะห์ได้ ใช้ค่าเริ่มต้น',
          chart_reasoning: 'ใช้กราฟแท่งเปรียบเทียบข้อมูลพื้นฐาน',
          data_aggregation: 'count',
          x_axis: 'country',
          y_axis: 'medal_count',
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

      // จำลองการประมวลผล
      await new Promise((resolve) => setTimeout(resolve, 1000))

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'status',
          message: 'กำลังสร้างผลลัพธ์...',
          progress: 80,
        }),
        event: 'update',
      })

      // สร้างผลลัพธ์ตาม columns ที่วิเคราะห์ได้
      const mockResult = {
        chart_type: columnAnalysis.chart_type,
        title: `ผลลัพธ์สำหรับ: ${userQuery}`,
        data: [
          { label: 'ข้อมูลตัวอย่าง 1', value: 100 },
          { label: 'ข้อมูลตัวอย่าง 2', value: 200 },
          { label: 'ข้อมูลตัวอย่าง 3', value: 150 },
        ],
        metadata: {
          columns_used: columnAnalysis.required_columns,
          aggregation_method: columnAnalysis.data_aggregation || 'count',
          filters_applied: [],
          total_records: 3,
          data_range: 'mock data based on analysis',
          analysis: columnAnalysis.analysis,
          chart_reasoning: columnAnalysis.chart_reasoning,
          alternative_charts: columnAnalysis.alternative_charts || [],
          axis_info: {
            x_axis: columnAnalysis.x_axis,
            y_axis: columnAnalysis.y_axis,
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
          result: mockResult,
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
