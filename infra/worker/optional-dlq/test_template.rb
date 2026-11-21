require 'yaml'
require 'minitest/autorun'

# Long-form intrinsics keep substitutions and references visible to Ruby's YAML parser.
class OptionalDlqTest < Minitest::Test
  def setup
    @template = YAML.safe_load(File.read(File.join(__dir__, 'template.yaml')))
    @queue = @template.fetch('Resources').fetch('DeadLetterQueue')
  end

  def test_isolated_stack_with_one_retained_queue_and_no_cross_stack_export
    assert_equal %w[AWSTemplateFormatVersion Description Outputs Parameters Resources Rules], @template.keys.sort
    assert_equal ['DeadLetterQueue'], @template.fetch('Resources').keys
    assert_equal %w[DeletionPolicy Properties Type UpdateReplacePolicy], @queue.keys.sort
    assert_equal 'AWS::SQS::Queue', @queue.fetch('Type')
    assert_equal 'Retain', @queue.fetch('DeletionPolicy')
    assert_equal 'Retain', @queue.fetch('UpdateReplacePolicy')
    assert_equal({ 'DeadLetterQueueArn' => { 'Value' => { 'Fn::GetAtt' => %w[DeadLetterQueue Arn] } } },
                 @template.fetch('Outputs'))
  end

  def test_standard_generated_name_encryption_retention_and_single_source_allowlist
    props = @queue.fetch('Properties')
    # An allowlist excludes QueueName, RedrivePolicy, KMS overrides and unrelated settings.
    assert_equal %w[FifoQueue MessageRetentionPeriod RedriveAllowPolicy SqsManagedSseEnabled], props.keys.sort
    assert_equal false, props.fetch('FifoQueue')
    assert_equal true, props.fetch('SqsManagedSseEnabled')
    assert_equal 14 * 24 * 60 * 60, props.fetch('MessageRetentionPeriod')
    arn = 'arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:${ExistingSourceQueueName}'
    assert_equal({ 'redrivePermission' => 'byQueue', 'sourceQueueArns' => [{ 'Fn::Sub' => arn }] },
                 props.fetch('RedriveAllowPolicy'))
  end

  def test_only_an_explicit_standard_queue_name_is_accepted
    params = @template.fetch('Parameters')
    assert_equal ['ExistingSourceQueueName'], params.keys
    name = params.fetch('ExistingSourceQueueName')
    assert_equal 'String', name.fetch('Type')
    refute name.key?('Default')
    # CloudFormation applies AllowedPattern to the entire parameter value.
    pattern = /\A(?:#{name.fetch('AllowedPattern')})\z/
    ['a', 'Test-Source_9', 'x' * 80].each { |s| assert_match pattern, s }
    ['', 'x' * 81, 'fixture.fifo', '*', 'a,b', 'a:b', 'path/name', 'has space', "name\n"].each do |s|
      refute_match pattern, s
    end
  end

  def test_region_assertion_is_unconditional
    region = @template.fetch('Rules').fetch('ProjectRegion')
    refute region.key?('RuleCondition')
    assert_equal [{ 'Fn::Equals' => [{ 'Ref' => 'AWS::Region' }, 'us-east-1'] }],
                 region.fetch('Assertions').map { |assertion| assertion.fetch('Assert') }
  end
end
