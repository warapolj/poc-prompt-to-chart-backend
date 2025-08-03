import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from '@langchain/google-genai'
import { z } from 'zod'
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import { MemoryVectorStore } from 'langchain/vectorstores/memory'
import { RetrievalQAChain } from 'langchain/chains'

// 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
const GEMINI_API_KEY = 'AIzaSyBx1aswV7w6-0pROZ5IWYLlHcSSYYbjEbw'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.post('/api/query', async (c) => {
  const body = await c.req.json()
  const userQuery = z.string().parse(body.query)

  const model = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-pro',
    apiKey: GEMINI_API_KEY,
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
      apiKey: GEMINI_API_KEY,
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
