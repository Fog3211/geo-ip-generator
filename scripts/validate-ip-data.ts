/**
 * IP数据验证脚本
 * 功能：
 * 1. 从数据库随机采样IP
 * 2. 调用多个第三方API验证数据准确性
 * 3. 交叉验证和统计分析
 * 4. 生成详细的验证报告和错误日志
 */

import fs from 'fs';
import path from 'path';
import { silentDb as db } from '../src/server/db.js';

// 验证结果接口
interface ValidationResult {
  ip: string;
  expected: {
    countryCode: string;
    countryName: string;
    region?: string;
    city?: string;
  };
  actual: {
    [provider: string]: {
      countryCode?: string;
      countryName?: string;
      region?: string;
      city?: string;
      success: boolean;
      error?: string;
    };
  };
  isCorrect: boolean;
  confidence: number; // 0-1, 基于多个API的一致性
}

// 第三方API响应接口
interface ApiResponse {
  countryCode?: string;
  countryName?: string;
  region?: string;
  city?: string;
}

// 验证报告接口
interface ValidationReport {
  timestamp: string;
  summary: {
    totalSamples: number;
    correctCount: number;
    incorrectCount: number;
    errorCount: number;
    accuracyRate: number;
    averageConfidence: number;
  };
  providerStats: {
    [provider: string]: {
      successRate: number;
      accuracyRate: number;
      responseTime: number;
    };
  };
  results: ValidationResult[];
  errors: ValidationResult[];
}

class IpDataValidator {
  private readonly sampleSize: number;
  private readonly outputDir: string;
  private readonly maxRetries = 3;
  private readonly requestDelay = 1500; // 保守一点，降低免费 provider 的限流风险

  constructor(sampleSize = 100) {
    this.sampleSize = sampleSize;
    this.outputDir = path.join(process.cwd(), 'data', 'validation');
    this.ensureOutputDir();
  }

  private ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * 从数据库随机采样IP
   */
  async sampleIpAddresses(): Promise<Array<{
    ip: string;
    countryCode: string;
    countryName: string;
    region?: string;
    city?: string;
  }>> {
    console.log(`🎯 开始采样 ${this.sampleSize} 个IP地址...`);

    // 获取所有有IP数据的国家
    const countriesWithIps = await db.country.findMany({
      where: {
        ipRanges: {
          some: {}
        }
      },
      include: {
        ipRanges: {
          include: {
            region: true,
            city: true,
          },
          take: 50, // 每个国家最多取50个IP段
        },
      },
    });

    console.log(`📊 找到 ${countriesWithIps.length} 个有IP数据的国家/地区`);

    const samples: Array<{
      ip: string;
      countryCode: string;
      countryName: string;
      region?: string;
      city?: string;
    }> = [];

    // 确保地区分布均匀
    const samplesPerCountry = Math.max(1, Math.floor(this.sampleSize / Math.min(countriesWithIps.length, 20)));

    for (const country of countriesWithIps.slice(0, 20)) { // 限制最多20个国家避免采样过于分散
      const targetSamples = Math.min(samplesPerCountry, country.ipRanges.length);

      for (let i = 0; i < targetSamples && samples.length < this.sampleSize; i++) {
        const randomRange = country.ipRanges[Math.floor(Math.random() * country.ipRanges.length)];
        if (randomRange) {
          const randomIp = this.generateRandomIpInRange(randomRange.startIp, randomRange.endIp);

          samples.push({
            ip: randomIp,
            countryCode: country.code2,
            countryName: country.nameEn,
            region: randomRange.region?.name,
            city: randomRange.city?.name,
          });
        }
      }
    }

    // 如果样本不够，随机补充
    while (samples.length < this.sampleSize && countriesWithIps.length > 0) {
      const randomCountry = countriesWithIps[Math.floor(Math.random() * countriesWithIps.length)];
      if (randomCountry && randomCountry.ipRanges.length > 0) {
        const randomRange = randomCountry.ipRanges[Math.floor(Math.random() * randomCountry.ipRanges.length)];
        if (!randomRange) continue;
        const randomIp = this.generateRandomIpInRange(randomRange.startIp, randomRange.endIp);

        samples.push({
          ip: randomIp,
          countryCode: randomCountry.code2,
          countryName: randomCountry.nameEn,
          region: randomRange.region?.name,
          city: randomRange.city?.name,
        });
      }
    }

    console.log(`✅ 采样完成，共 ${samples.length} 个IP地址`);
    console.log(`📍 覆盖国家: ${[...new Set(samples.map(s => s.countryCode))].join(', ')}`);

    return samples.slice(0, this.sampleSize);
  }

  /**
   * 在IP范围内生成随机IP
   */
  private generateRandomIpInRange(startIp: string, endIp: string): string {
    const startParts = startIp.split('.').map(Number);
    const endParts = endIp.split('.').map(Number);

    // 确保IP地址格式正确
    if (startParts.length !== 4 || endParts.length !== 4) {
      throw new Error(`Invalid IP format: ${startIp} or ${endIp}`);
    }

    // 确保所有部分都是有效数字
    if (startParts.some(part => part === undefined || isNaN(part)) || 
        endParts.some(part => part === undefined || isNaN(part))) {
      throw new Error(`Invalid IP format: ${startIp} or ${endIp}`);
    }

    const startInt = (startParts[0]! << 24) + (startParts[1]! << 16) + (startParts[2]! << 8) + startParts[3]!;
    const endInt = (endParts[0]! << 24) + (endParts[1]! << 16) + (endParts[2]! << 8) + endParts[3]!;

    const randomInt = startInt + Math.floor(Math.random() * (endInt - startInt + 1));

    return [
      (randomInt >>> 24) & 255,
      (randomInt >>> 16) & 255,
      (randomInt >>> 8) & 255,
      randomInt & 255
    ].join('.');
  }

  /**
   * 调用ip-api.com API
   */
  async queryIpApi(ip: string): Promise<{ data: ApiResponse; responseTime: number }> {
    const startTime = Date.now();

    try {
      const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== 'success') {
        throw new Error(data.message || 'API returned error status');
      }

      return {
        data: {
          countryCode: data.countryCode,
          countryName: data.country,
          region: data.regionName,
          city: data.city,
        },
        responseTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`ip-api.com error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 调用 db-ip.com free API
   */
  async queryDbIp(ip: string): Promise<{ data: ApiResponse; responseTime: number }> {
    const startTime = Date.now();

    try {
      const response = await fetch(`https://api.db-ip.com/v2/free/${ip}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      return {
        data: {
          countryCode: data.countryCode,
          countryName: data.countryName,
          region: data.stateProv || undefined,
          city: data.city || undefined,
        },
        responseTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`db-ip.com error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 调用geojs.io API
   */
  async queryGeoJs(ip: string): Promise<{ data: ApiResponse; responseTime: number }> {
    const startTime = Date.now();

    try {
      const response = await fetch(`https://get.geojs.io/v1/ip/geo/${ip}.json`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      return {
        data: {
          countryCode: data.country_code,
          countryName: data.country,
          region: data.region,
          city: data.city,
        },
        responseTime: Date.now() - startTime
      };
    } catch (error) {
      throw new Error(`geojs.io error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 验证单个IP地址
   */
  async validateIpAddress(sample: {
    ip: string;
    countryCode: string;
    countryName: string;
    region?: string;
    city?: string;
  }): Promise<ValidationResult> {
    console.log(`🔍 验证IP: ${sample.ip} (预期: ${sample.countryCode})`);

    const result: ValidationResult = {
      ip: sample.ip,
      expected: {
        countryCode: sample.countryCode,
        countryName: sample.countryName,
        region: sample.region,
        city: sample.city,
      },
      actual: {},
      isCorrect: false,
      confidence: 0,
    };

    // 今天使用哪些API（轮换策略）
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24));
    const apiProviders = [
      { name: 'ip-api.com', fn: this.queryIpApi.bind(this) },
      { name: 'geojs.io', fn: this.queryGeoJs.bind(this) },
      { name: 'db-ip.com', fn: this.queryDbIp.bind(this) },
    ];

    // 每天轮换使用不同的API组合
    const selectedApis = [
      apiProviders[dayOfYear % 3]!,
      apiProviders[(dayOfYear + 1) % 3]!,
    ];

    // 调用选定的API
    for (const api of selectedApis) {
      try {
        await this.delay(this.requestDelay); // 避免API限制

        const { data, responseTime } = await api.fn(sample.ip);

        result.actual[api.name] = {
          countryCode: data.countryCode,
          countryName: data.countryName,
          region: data.region,
          city: data.city,
          success: true,
        };

        console.log(`✅ ${api.name}: ${data.countryCode} (${responseTime}ms)`);

      } catch (error) {
        result.actual[api.name] = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };

        console.log(`❌ ${api.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // 分析结果一致性
    this.analyzeResults(result);

    return result;
  }

  /**
   * 分析验证结果
   */
  private analyzeResults(result: ValidationResult): void {
    const successfulResponses = Object.entries(result.actual).filter(([_, response]) => response.success);

    if (successfulResponses.length === 0) {
      result.confidence = 0;
      result.isCorrect = false;
      return;
    }

    // 检查国家代码匹配度
    const countryMatches = successfulResponses.filter(([_, response]) =>
      response.countryCode?.toUpperCase() === result.expected.countryCode.toUpperCase()
    );

    // 计算置信度
    result.confidence = countryMatches.length / successfulResponses.length;

    // 至少50%的API返回正确结果才认为是正确的
    result.isCorrect = result.confidence >= 0.5;

    console.log(`📊 匹配度: ${countryMatches.length}/${successfulResponses.length} (${(result.confidence * 100).toFixed(1)}%)`);
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 运行完整验证
   */
  async runValidation(): Promise<ValidationReport> {
    console.log('🚀 开始IP数据验证...');

    const startTime = Date.now();
    const samples = await this.sampleIpAddresses();
    const results: ValidationResult[] = [];

    console.log(`\n📝 开始验证 ${samples.length} 个IP地址...`);

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (!sample) continue; // 跳过undefined样本
      
      console.log(`\n[${i + 1}/${samples.length}]`);

      try {
        const result = await this.validateIpAddress(sample);
        results.push(result);
      } catch (error) {
        console.error(`💥 验证失败: ${sample.ip}`, error);
        results.push({
          ip: sample.ip,
          expected: {
            countryCode: sample.countryCode,
            countryName: sample.countryName,
            region: sample.region,
            city: sample.city,
          },
          actual: {},
          isCorrect: false,
          confidence: 0,
        });
      }
    }

    // 生成报告
    const report = this.generateReport(results, Date.now() - startTime);

    // 保存报告
    await this.saveReport(report);

    console.log(`\n🎉 验证完成！总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

    return report;
  }

  /**
   * 生成验证报告
   */
  private generateReport(results: ValidationResult[], duration: number): ValidationReport {
    const correctResults = results.filter(r => r.isCorrect);
    const incorrectResults = results.filter(r => !r.isCorrect && Object.keys(r.actual).length > 0);
    const errorResults = results.filter(r => Object.keys(r.actual).length === 0);

    const totalConfidence = results.reduce((sum, r) => sum + r.confidence, 0);

    // 计算各API提供商的统计信息
    const providerStats: { [provider: string]: { successRate: number; accuracyRate: number; responseTime: number } } = {};

    const allProviders = [...new Set(results.flatMap(r => Object.keys(r.actual)))];

    for (const provider of allProviders) {
      const providerResults = results.map(r => r.actual[provider]).filter((r): r is NonNullable<typeof r> => r !== undefined);
      const successfulResults = providerResults.filter(r => r.success);
      const accurateResults = results.filter(r =>
        r.actual[provider]?.success &&
        r.actual[provider]?.countryCode?.toUpperCase() === r.expected.countryCode.toUpperCase()
      );

      providerStats[provider] = {
        successRate: providerResults.length > 0 ? successfulResults.length / providerResults.length : 0,
        accuracyRate: providerResults.length > 0 ? accurateResults.length / providerResults.length : 0,
        responseTime: 0, // 这里可以计算平均响应时间
      };
    }

    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalSamples: results.length,
        correctCount: correctResults.length,
        incorrectCount: incorrectResults.length,
        errorCount: errorResults.length,
        accuracyRate: results.length > 0 ? correctResults.length / results.length : 0,
        averageConfidence: results.length > 0 ? totalConfidence / results.length : 0,
      },
      providerStats,
      results,
      errors: incorrectResults.concat(errorResults),
    };
  }

  /**
   * 保存验证报告
   */
  private async saveReport(report: ValidationReport): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // 保存完整报告
    const reportPath = path.join(this.outputDir, `validation-report-${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // 保存简化的摘要
    const summaryPath = path.join(this.outputDir, 'latest-validation-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      timestamp: report.timestamp,
      summary: report.summary,
      providerStats: report.providerStats,
      errorCount: report.errors.length,
    }, null, 2));

    // 如果有错误，保存错误日志
    if (report.errors.length > 0) {
      const errorLogPath = path.join(this.outputDir, `errors-${timestamp}.json`);
      fs.writeFileSync(errorLogPath, JSON.stringify(report.errors, null, 2));
    }

    console.log(`📊 验证报告:`);
    console.log(`   - 总样本: ${report.summary.totalSamples}`);
    console.log(`   - 正确: ${report.summary.correctCount} (${(report.summary.accuracyRate * 100).toFixed(1)}%)`);
    console.log(`   - 错误: ${report.summary.incorrectCount}`);
    console.log(`   - 失败: ${report.summary.errorCount}`);
    console.log(`   - 平均置信度: ${(report.summary.averageConfidence * 100).toFixed(1)}%`);
    console.log(`📁 报告保存: ${reportPath}`);

    if (report.errors.length > 0) {
      console.log(`🔍 错误详情:`);
      report.errors.slice(0, 5).forEach(error => {
        console.log(`   - ${error.ip}: 预期 ${error.expected.countryCode}, 实际 ${Object.values(error.actual).map(a => a.countryCode).filter(Boolean).join('/')}`);
      });
      if (report.errors.length > 5) {
        console.log(`   ... 还有 ${report.errors.length - 5} 个错误，查看完整日志`);
      }
    }
  }
}

/**
 * 主验证函数
 */
async function validateIpData(sampleSize = 100): Promise<void> {
  const validator = new IpDataValidator(sampleSize);

  try {
    await validator.runValidation();
  } catch (error) {
    console.error('💥 验证过程出现致命错误:', error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

// 运行脚本
if (typeof process !== 'undefined' && process.argv && process.argv[1] && import.meta.url?.endsWith(process.argv[1])) {
  const sampleSize = process.argv[2] ? parseInt(process.argv[2]) : 100;
  validateIpData(sampleSize).catch(error => {
    console.error('💥 脚本执行失败:', error);
    process.exit(1);
  });
}

export { validateIpData, IpDataValidator }; 