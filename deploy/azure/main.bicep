// TEMPLATE. Never deployed from this repository; see README.md.
//
// One small Linux VM for the coordinator, one data disk for the SQLite file,
// and a network security group that opens SSH and nothing else. There is
// deliberately no public IP for the HTTP API: the executor dials OUT, and the
// API binds to loopback or the tailnet.

@description('Azure region. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Name prefix for every resource this template creates.')
param namePrefix string = 'ducky'

@description('VM size. B-series is deliberate: this is one small assistant.')
param vmSize string = 'Standard_B2s'

@description('Admin user for SSH. Password authentication is disabled outright.')
param adminUsername string

@description('SSH public key. A public key, never a private one, and never a password.')
@secure()
param adminPublicKey string

@description('Your own address, so SSH is not open to the internet. CIDR.')
param sshSourceAddressPrefix string

@description('cloud-init, base64 encoded. See cloud-init.yaml.')
param customData string

var vnetName = '${namePrefix}-vnet'
var subnetName = '${namePrefix}-subnet'
var nsgName = '${namePrefix}-nsg'
var nicName = '${namePrefix}-nic'
var vmName = '${namePrefix}-vm'
var dataDiskName = '${namePrefix}-data'

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        // The ONLY inbound rule. Scoped to one source address, not the
        // internet, and intended to be removed once a tailnet is in place.
        name: 'ssh-from-operator'
        properties: {
          priority: 1000
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: sshSourceAddressPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        // Belt and braces. Azure denies by default; saying so out loud means a
        // later "just open 8788 for a minute" has to delete a rule named this.
        name: 'deny-all-other-inbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: '10.42.1.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: nicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          // NO publicIPAddress. The API is never reachable from the internet.
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: '${vnet.id}/subnets/${subnetName}' }
        }
      }
    ]
  }
}

resource dataDisk 'Microsoft.Compute/disks@2023-10-02' = {
  name: dataDiskName
  location: location
  sku: { name: 'Premium_LRS' }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: 32
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      // Passwords are disabled outright, not merely unset.
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            { path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: adminPublicKey }
          ]
        }
      }
      customData: customData
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: { storageAccountType: 'Premium_LRS' }
      }
      dataDisks: [
        {
          lun: 0
          createOption: 'Attach'
          managedDisk: { id: dataDisk.id }
        }
      ]
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
  }
}

// The private address, because there is no public one to output.
output privateIpAddress string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output vmName string = vm.name
