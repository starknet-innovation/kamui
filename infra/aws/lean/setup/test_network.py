"""Offline network-boundary checks; no AWS API or template deployment."""
import copy
import ipaddress
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent

def validate(template):
    resources = template['Resources']
    expected = {
        'Vpc': 'AWS::EC2::VPC', 'InternetGateway': 'AWS::EC2::InternetGateway',
        'GatewayAttachment': 'AWS::EC2::VPCGatewayAttachment',
        'PublicSubnet': 'AWS::EC2::Subnet', 'PublicRouteTable': 'AWS::EC2::RouteTable',
        'InternetRoute': 'AWS::EC2::Route',
        'SubnetRouteAssociation': 'AWS::EC2::SubnetRouteTableAssociation',
        'WebSecurityGroup': 'AWS::EC2::SecurityGroup',
    }
    assert {name: resource['Type'] for name, resource in resources.items()} == expected
    assert template['Parameters']['Role']['AllowedValues'] == ['backend', 'pepper']
    group = resources['WebSecurityGroup']['Properties']
    assert group['VpcId'] == {'Ref': 'Vpc'}
    assert 'GroupName' not in group
    assert sorted((r['IpProtocol'], r['FromPort'], r['ToPort'], r['CidrIp']) for r in group['SecurityGroupIngress']) == [('tcp', 80, 80, '0.0.0.0/0'), ('tcp', 443, 443, '0.0.0.0/0')]
    assert [(r['IpProtocol'], r['FromPort'], r['ToPort'], r['CidrIp']) for r in group['SecurityGroupEgress']] == [('tcp', 443, 443, '0.0.0.0/0')]
    route = resources['InternetRoute']
    assert route['DependsOn'] == 'GatewayAttachment'
    assert route['Properties'] == {'RouteTableId': {'Ref': 'PublicRouteTable'}, 'DestinationCidrBlock': '0.0.0.0/0', 'GatewayId': {'Ref': 'InternetGateway'}}
    subnet = resources['PublicSubnet']['Properties']
    assert subnet['MapPublicIpOnLaunch'] is False
    assert subnet['AssignIpv6AddressOnCreation'] is False
    assert subnet['VpcId'] == {'Ref': 'Vpc'}
    assert subnet['AvailabilityZone'] == {'Ref': 'AvailabilityZone'}
    assert resources['SubnetRouteAssociation']['Properties'] == {'SubnetId': {'Ref': 'PublicSubnet'}, 'RouteTableId': {'Ref': 'PublicRouteTable'}}
    params = template['Parameters']
    assert ipaddress.ip_network(params['SubnetCidr']['Default']).subnet_of(ipaddress.ip_network(params['VpcCidr']['Default']))
    assert params['VpcCidr']['AllowedValues'] == [params['VpcCidr']['Default']]
    assert params['SubnetCidr']['AllowedValues'] == [params['SubnetCidr']['Default']]
    assert set(template['Outputs']) == {'VpcId', 'SubnetId', 'SecurityGroupId', 'AvailabilityZone'}
    assert all('Export' not in value for value in template['Outputs'].values())
    assert len(json.dumps(template).encode()) < 51200
    for resource in resources.values():
        context = resource['Metadata']['com.aws.cloudformation.Context']
        assert context['why'] and context['must']

class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads((HERE/'network.json').read_text())

    def test_direct_origin_network_is_dedicated_and_matches_boundaries(self):
        validate(self.template)

    def test_widened_ingress_or_egress_and_paid_resources_are_rejected(self):
        for mutation in ['ssh', 'all-egress', 'nat']:
            t = copy.deepcopy(self.template)
            if mutation == 'ssh':
                t['Resources']['WebSecurityGroup']['Properties']['SecurityGroupIngress'].append({'IpProtocol': 'tcp', 'FromPort': 22, 'ToPort': 22, 'CidrIp': '0.0.0.0/0'})
            elif mutation == 'all-egress':
                t['Resources']['WebSecurityGroup']['Properties']['SecurityGroupEgress'] = [{'IpProtocol': '-1', 'CidrIp': '0.0.0.0/0'}]
            else:
                t['Resources']['Nat'] = {'Type': 'AWS::EC2::NatGateway'}
            with self.assertRaises((AssertionError, KeyError)):
                validate(t)

    def test_unattached_route_or_unreviewed_public_addressing_is_rejected(self):
        for mutation in ['attachment', 'public-ip', 'ipv6']:
            t = copy.deepcopy(self.template)
            if mutation == 'attachment':
                del t['Resources']['InternetRoute']['DependsOn']
            elif mutation == 'public-ip':
                t['Resources']['PublicSubnet']['Properties']['MapPublicIpOnLaunch'] = True
            else:
                t['Resources']['PublicSubnet']['Properties']['AssignIpv6AddressOnCreation'] = True
            with self.assertRaises((AssertionError, KeyError)):
                validate(t)

if __name__ == '__main__':
    unittest.main()
