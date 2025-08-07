// Shadcn Chart Configuration and Data Formatting
// สำหรับ format ข้อมูลให้ตรงกับ shadcn charts
// Colors for charts
const CHART_COLORS = [
    'hsl(var(--chart-1))',
    'hsl(var(--chart-2))',
    'hsl(var(--chart-3))',
    'hsl(var(--chart-4))',
    'hsl(var(--chart-5))',
    '#8884d8',
    '#82ca9d',
    '#ffc658',
    '#ff7300',
    '#0088fe',
    '#00c49f',
    '#ffbb28',
    '#ff8042',
    '#8dd1e1',
    '#d084d0',
];
// Chart configurations for shadcn
export const SHADCN_CHART_CONFIGS = {
    bar: {
        type: 'bar',
        dataFormat: 'simple',
        requiredFields: ['name', 'value'],
        config: {
            layout: 'horizontal',
            margin: { top: 20, right: 30, left: 20, bottom: 5 },
        },
        formatData: (data) => {
            return data.map((item, index) => ({
                name: item.label || item.name || `Item ${index + 1}`,
                value: Number(item.value || item.count || 0),
                fill: CHART_COLORS[index % CHART_COLORS.length],
            }));
        },
        getChartConfig: () => ({
            value: {
                label: 'จำนวน',
                color: 'hsl(var(--chart-1))',
            },
        }),
    },
    column: {
        type: 'column',
        dataFormat: 'simple',
        requiredFields: ['name', 'value'],
        config: {
            layout: 'vertical',
            margin: { top: 20, right: 30, left: 20, bottom: 60 },
        },
        formatData: (data) => {
            return data.map((item, index) => ({
                name: item.label || item.name || `Item ${index + 1}`,
                value: Number(item.value || item.count || 0),
                fill: CHART_COLORS[index % CHART_COLORS.length],
            }));
        },
        getChartConfig: () => ({
            value: {
                label: 'จำนวน',
                color: 'hsl(var(--chart-1))',
            },
        }),
    },
    line: {
        type: 'line',
        dataFormat: 'time-series',
        requiredFields: ['name', 'value'],
        config: {
            margin: { top: 20, right: 30, left: 20, bottom: 20 },
        },
        formatData: (data) => {
            return data
                .map((item, index) => ({
                name: item.label || item.name || item.year || `Point ${index + 1}`,
                value: Number(item.value || item.count || 0),
                year: item.year || item.name,
            }))
                .sort((a, b) => {
                // Sort by year if available
                if (a.year && b.year && !isNaN(Number(a.year)) && !isNaN(Number(b.year))) {
                    return Number(a.year) - Number(b.year);
                }
                return 0;
            });
        },
        getChartConfig: () => ({
            value: {
                label: 'จำนวน',
                color: 'hsl(var(--chart-1))',
            },
        }),
    },
    area: {
        type: 'area',
        dataFormat: 'time-series',
        requiredFields: ['name', 'value'],
        config: {
            margin: { top: 20, right: 30, left: 20, bottom: 20 },
        },
        formatData: (data) => {
            return data
                .map((item, index) => ({
                name: item.label || item.name || item.year || `Point ${index + 1}`,
                value: Number(item.value || item.count || 0),
                year: item.year || item.name,
            }))
                .sort((a, b) => {
                if (a.year && b.year && !isNaN(Number(a.year)) && !isNaN(Number(b.year))) {
                    return Number(a.year) - Number(b.year);
                }
                return 0;
            });
        },
        getChartConfig: () => ({
            value: {
                label: 'จำนวน',
                color: 'hsl(var(--chart-1))',
            },
        }),
    },
    pie: {
        type: 'pie',
        dataFormat: 'radial',
        requiredFields: ['name', 'value'],
        config: {
            cx: '50%',
            cy: '50%',
            outerRadius: 100,
            dataKey: 'value',
        },
        formatData: (data) => {
            const total = data.reduce((sum, item) => sum + Number(item.value || item.count || 0), 0);
            return data.map((item, index) => {
                const value = Number(item.value || item.count || 0);
                return {
                    name: item.label || item.name || `Segment ${index + 1}`,
                    value: value,
                    percentage: total > 0 ? Math.round((value / total) * 100) : 0,
                    fill: CHART_COLORS[index % CHART_COLORS.length],
                };
            });
        },
        getChartConfig: () => {
            const config = {};
            CHART_COLORS.forEach((color, index) => {
                config[`segment${index + 1}`] = {
                    label: `Segment ${index + 1}`,
                    color: color,
                };
            });
            return config;
        },
    },
    donut: {
        type: 'donut',
        dataFormat: 'radial',
        requiredFields: ['name', 'value'],
        config: {
            cx: '50%',
            cy: '50%',
            innerRadius: 60,
            outerRadius: 100,
            dataKey: 'value',
        },
        formatData: (data) => {
            const total = data.reduce((sum, item) => sum + Number(item.value || item.count || 0), 0);
            return data.map((item, index) => {
                const value = Number(item.value || item.count || 0);
                return {
                    name: item.label || item.name || `Segment ${index + 1}`,
                    value: value,
                    percentage: total > 0 ? Math.round((value / total) * 100) : 0,
                    fill: CHART_COLORS[index % CHART_COLORS.length],
                };
            });
        },
        getChartConfig: () => {
            const config = {};
            CHART_COLORS.forEach((color, index) => {
                config[`segment${index + 1}`] = {
                    label: `Segment ${index + 1}`,
                    color: color,
                };
            });
            return config;
        },
    },
    scatter: {
        type: 'scatter',
        dataFormat: 'scatter',
        requiredFields: ['x', 'y'],
        config: {
            margin: { top: 20, right: 30, left: 20, bottom: 20 },
        },
        formatData: (data) => {
            return data.map((item, index) => ({
                x: Number(item.x || item.value || index),
                y: Number(item.y || item.count || Math.random() * 100),
                name: item.label || item.name || `Point ${index + 1}`,
                fill: CHART_COLORS[index % CHART_COLORS.length],
            }));
        },
        getChartConfig: () => ({
            x: {
                label: 'X-Axis',
                color: 'hsl(var(--chart-1))',
            },
            y: {
                label: 'Y-Axis',
                color: 'hsl(var(--chart-2))',
            },
        }),
    },
    histogram: {
        type: 'histogram',
        dataFormat: 'simple',
        requiredFields: ['range', 'frequency'],
        config: {
            margin: { top: 20, right: 30, left: 20, bottom: 20 },
        },
        formatData: (data) => {
            return data.map((item, index) => ({
                range: item.label || item.range || item.name || `Range ${index + 1}`,
                frequency: Number(item.value || item.frequency || item.count || 0),
                fill: CHART_COLORS[0], // Histogram typically uses single color
            }));
        },
        getChartConfig: () => ({
            frequency: {
                label: 'ความถี่',
                color: 'hsl(var(--chart-1))',
            },
        }),
    },
};
// Helper function to format data for specific chart type
export function formatDataForShadcn(chartType, rawData) {
    const chartDef = SHADCN_CHART_CONFIGS[chartType];
    if (!chartDef) {
        throw new Error(`Unsupported chart type: ${chartType}`);
    }
    const formattedData = chartDef.formatData(rawData);
    const chartConfig = chartDef.getChartConfig();
    return {
        data: formattedData,
        config: chartDef.config,
        chartConfig: chartConfig,
    };
}
// Helper function to get chart component name for shadcn
export function getShadcnChartComponent(chartType) {
    const componentMap = {
        bar: 'BarChart',
        column: 'BarChart', // Same component, different orientation
        line: 'LineChart',
        area: 'AreaChart',
        pie: 'PieChart',
        donut: 'PieChart', // Same component with innerRadius
        scatter: 'ScatterChart',
        histogram: 'BarChart', // Histogram uses BarChart
    };
    return componentMap[chartType] || 'BarChart';
}
// Helper function to generate complete chart response for frontend
export function generateShadcnChartResponse(chartType, rawData, title, metadata = {}) {
    const formatted = formatDataForShadcn(chartType, rawData);
    return {
        chart_type: chartType,
        component: getShadcnChartComponent(chartType),
        title: title,
        data: formatted.data,
        config: formatted.config,
        chartConfig: formatted.chartConfig,
        metadata: {
            ...metadata,
            total_data_points: formatted.data.length,
            chart_library: 'shadcn',
            formatted_at: new Date().toISOString(),
        },
    };
}
