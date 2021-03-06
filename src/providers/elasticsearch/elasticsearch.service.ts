import { Client } from '@elastic/elasticsearch';
import { Index, Search } from '@elastic/elasticsearch/api/requestParams';
import { TransportRequestOptions } from '@elastic/elasticsearch/lib/Transport';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import createAwsElasticsearchConnector from 'aws-elasticsearch-connector';
import AWS from 'aws-sdk';
import PQueue from 'p-queue';
import pRetry from 'p-retry';
import { Configuration } from '../../config/configuration.interface';

@Injectable()
export class ElasticSearchService {
  private logger = new Logger(ElasticSearchService.name);
  private queue = new PQueue({ concurrency: 1 });
  private elasticSearchConfig = this.configService.get<
    Configuration['elasticSearch']
  >('elasticSearch');
  client?: Client;

  constructor(private configService: ConfigService) {
    if (this.elasticSearchConfig.aws?.accessKeyId) {
      AWS.config.update({
        accessKeyId: this.elasticSearchConfig.aws.accessKeyId,
        secretAccessKey: this.elasticSearchConfig.aws.secretAccessKey,
        region: this.elasticSearchConfig.aws.region,
      });
      this.client = new Client({
        ...createAwsElasticsearchConnector(AWS.config),
        node: this.elasticSearchConfig.node,
      });
    } else if (this.elasticSearchConfig.node)
      this.client = new Client({
        auth: this.elasticSearchConfig.auth,
        node: this.elasticSearchConfig.node,
      });
    else this.logger.warn('ElasticSearch tracking is not enabled');
  }

  index(index: string, record: Record<string, any>, params?: Index) {
    if (this.client)
      this.queue
        .add(() =>
          pRetry(() => this.indexRecord(index, record, params), {
            retries: this.elasticSearchConfig.retries,
            onFailedAttempt: (error) => {
              this.logger.error(
                `Indexing record failed, retrying (${error.retriesLeft} attempts left)`,
                error.name,
              );
            },
          }),
        )
        .then(() => {})
        .catch(() => {});
  }

  search(
    params?: Search<Record<string, any>>,
    options?: TransportRequestOptions,
  ) {
    if (this.client) return this.client.search(params, options);
  }

  /**
   * Delete old records from ElasticSearch
   * @param index - Index
   * @param days - Number of days ago (e.g., 30 will delete month-old data)
   */
  deleteOldRecords = async (index: string, days: number) => {
    const now = new Date();
    now.setDate(now.getDate() - days);
    if (this.client)
      return this.client.deleteByQuery({
        index,
        body: {
          query: {
            bool: {
              must: [
                {
                  range: {
                    date: {
                      lte: now,
                    },
                  },
                },
              ],
            },
          },
        },
      });
  };

  private async indexRecord(
    index: string,
    record: Record<string, any>,
    params?: Index,
  ) {
    return this.client.index({ index, body: record, ...params });
  }
}
